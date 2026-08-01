// OpenMeet intake sink: feeds the frozen OpenMeet platform from atmo's contrail
// ingest, replacing the legacy bsky-firehose-consumer -> RabbitMQ ->
// bsky-event-processor pipeline (three services and a broker) with a sink that
// rides the Worker ingest already running here.
//
// FORK DELTA — NOT UPSTREAM MATERIAL. This is deliberately scoped to
// tompscanlan/atmo-events and has a defined end of life: when the frozen
// platform no longer needs fresh network events, unset the secrets and delete
// this directory. It lives under `$lib/openmeet/` rather than beside the search
// sink so that delta is one self-contained directory rather than files
// interleaved with atmo's own concerns.
//
// The OpenMeet-specific knowledge all lives in ./event-transform and
// ./rsvp-transform, which are pure and import nothing from atmo or contrail.
// This file is the only part that knows about either — so lifting the transform
// pair into an out-of-process consumer (a generic webhook sink pointed at a
// service that owns these files) is a move, not a rewrite.
//
// Constraints inherited from the contrail Sink seam:
//   - sinks observe PUBLIC records only; space-scoped records never reach
//     applyEvents, so nothing private can leak to OpenMeet through here;
//   - a thrown sink is caught and logged by contrail and never blocks ingest,
//     so an OpenMeet outage degrades to "the platform misses these records",
//     not "atmo stops ingesting".
import type { ContrailConfig } from '@atmo-dev/contrail';
import { EVENT_COLLECTION, RSVP_COLLECTION, type IntakeRequest } from './types';
import { eventRequestFor, type TransformResult } from './event-transform';
import { rsvpRequestFor } from './rsvp-transform';

// Same derivation the search sink uses: the umbrella re-exports ContrailConfig
// but not Sink/RecordEvent, and contrail-base isn't a direct dependency.
type Sink = NonNullable<ContrailConfig['sinks']>[number];
type RecordEvent = Parameters<Sink['onRecords']>[0][number];
type SinkContext = Parameters<Sink['onRecords']>[1];

/** How many intake calls are in flight at once.
 *
 *  This sink fires on backfill batches as well as live ones (see `onRecords`),
 *  and a backfill batch can carry a prolific host's entire history. Unbounded
 *  fan-out would turn one page view into a few hundred simultaneous writes
 *  against the frozen platform. A small pool keeps throughput reasonable while
 *  bounding the burst; it is not a rate limiter and is not meant to be one. */
const MAX_IN_FLIGHT = 4;

export interface OpenMeetSinkBackend {
	/** Base URL of the OpenMeet API serving the intake endpoints. */
	url: string;
	/** Service key presented as `Authorization: Bearer`. Must be present in the
	 *  API's SERVICE_API_KEYS list. Dedicated to this sink rather than shared
	 *  with the legacy processor, so writes stay attributable while both run in
	 *  parallel during the soak. */
	apiKey: string;
	/** Tenant the records are ingested into, sent as `x-tenant-id`. */
	tenantId: string;
}

export interface OpenMeetSinkEnv {
	/** Intake API base URL. UNSET DISABLES THE SINK ENTIRELY — that is the
	 *  safety property that keeps a dev or preview instance from feeding
	 *  production. Nothing else needs to be configured for the sink to be inert. */
	OPENMEET_SINK_URL?: string;
	/** Service API key (write). Set via `wrangler secret put`, never committed. */
	OPENMEET_SINK_API_KEY?: string;
	/** Target tenant id. Set via `wrangler secret put`. */
	OPENMEET_SINK_TENANT_ID?: string;
}

/** Resolve the backend from Worker env, or null when unconfigured. Never
 *  throws: an unconfigured or half-configured Worker must degrade to "no
 *  OpenMeet feed", not crash ingest. Warns on the half-configured case so a
 *  typo'd secret surfaces in logs instead of silently no-op'ing. */
export function openMeetSinkBackendFromEnv(env?: OpenMeetSinkEnv): OpenMeetSinkBackend | null {
	if (!env?.OPENMEET_SINK_URL) return null;
	if (!env.OPENMEET_SINK_API_KEY) {
		console.warn(
			'[openmeet-sink] OPENMEET_SINK_URL is set but OPENMEET_SINK_API_KEY is not; sink disabled'
		);
		return null;
	}
	if (!env.OPENMEET_SINK_TENANT_ID) {
		console.warn(
			'[openmeet-sink] OPENMEET_SINK_URL is set but OPENMEET_SINK_TENANT_ID is not; sink disabled'
		);
		return null;
	}
	return {
		url: env.OPENMEET_SINK_URL,
		apiKey: env.OPENMEET_SINK_API_KEY,
		tenantId: env.OPENMEET_SINK_TENANT_ID
	};
}

/** Minimal fetch client for the OpenMeet intake API. */
export class OpenMeetIntakeClient {
	private readonly base: string;
	private readonly apiKey: string;
	private readonly tenantId: string;
	private readonly fetch: typeof fetch;

	constructor(backend: OpenMeetSinkBackend, fetchFn: typeof fetch = globalThis.fetch) {
		this.base = backend.url.replace(/\/+$/, '');
		this.apiKey = backend.apiKey;
		this.tenantId = backend.tenantId;
		this.fetch = fetchFn;
	}

	/** Issue one intake request. Resolves on success or a tolerated status;
	 *  throws otherwise so the caller can log and move on. */
	async send(request: IntakeRequest): Promise<void> {
		const query = request.query ? `?${new URLSearchParams(request.query)}` : '';
		// Call fetch detached rather than as `this.fetch(...)`: on workerd the
		// global fetch throws "Illegal invocation" when `this` is bound to a
		// non-global object, which method-call syntax would do. Node/undici is
		// lenient, so this only bites in the deployed Worker.
		const doFetch = this.fetch;
		const res = await doFetch(`${this.base}${request.path}${query}`, {
			method: request.method,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				'content-type': 'application/json',
				'x-tenant-id': this.tenantId
			},
			body: request.body === undefined ? undefined : JSON.stringify(request.body)
		});
		if (res.ok || request.tolerate.includes(res.status)) return;
		// No body echoed — it can carry record content or credentials into logs.
		throw new Error(`OpenMeet intake ${request.method} ${request.path} failed: ${res.status}`);
	}
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pooled<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>
): Promise<void> {
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const item = items[next++];
			await work(item);
		}
	});
	await Promise.all(runners);
}

/** Build the OpenMeet intake sink.
 *
 *  The backend is resolved lazily per batch via `getBackend` because a
 *  Cloudflare Worker only has env per invocation while `contrail` is
 *  constructed once at module load — the cron/xrpc handlers arm it (see
 *  $lib/contrail/index.ts) before ingest fires the sink. A null backend makes
 *  onRecords a no-op. */
export function createOpenMeetSink(
	getBackend: () => OpenMeetSinkBackend | null,
	fetchFn?: typeof fetch
): Sink {
	return {
		async onRecords(events: RecordEvent[], ctx: SinkContext): Promise<void> {
			const backend = getBackend();
			if (!backend) return;

			// `ctx.phase` is deliberately NOT consulted. Backfill batches are fed to
			// OpenMeet exactly like live ones, which is a considered decision rather
			// than an oversight (TS, 2026-08-01):
			//
			//   - The seam delivers phase:"backfill" on the LIVE Worker, not only
			//     from the `pnpm backfill` CLI. contrail lazily backfills an actor's
			//     records when an xrpc query names them, so an ordinary profile-page
			//     view (/p/[actor]/hosting, /p/[actor]/past-events) can hand this
			//     sink a person's entire back catalogue.
			//   - Feeding those records is desirable: the platform is missing ~1,890
			//     events and ~1,379 RSVPs that the cursor-less legacy consumer
			//     dropped, and the intake API is idempotent by source id, so a
			//     re-send is an update rather than a duplicate. Browsing closes the
			//     gap organically.
			//   - The cost is burstiness, bounded by MAX_IN_FLIGHT above, and the
			//     fact that there is no retry: a record whose POST fails is simply
			//     not fed until something touches it again.
			void ctx;

			// Events and RSVPs are collected SEPARATELY because they must not be
			// dispatched together — see the two-phase drain below.
			const eventRequests: IntakeRequest[] = [];
			const rsvpRequests: IntakeRequest[] = [];
			for (const e of events) {
				let result: TransformResult;
				let target: IntakeRequest[];
				if (e.collection === EVENT_COLLECTION) {
					result = eventRequestFor(e);
					target = eventRequests;
				} else if (e.collection === RSVP_COLLECTION) {
					result = rsvpRequestFor(e);
					target = rsvpRequests;
				} else continue;

				if (result.kind === 'skip') {
					// Malformed records are dropped, not retried — the same call the
					// legacy processor made. Logged so a systematic transform gap is
					// visible rather than silent.
					console.warn(`[openmeet-sink] skipping ${e.uri}: ${result.reason}`);
					continue;
				}
				target.push(result.request);
			}

			if (eventRequests.length === 0 && rsvpRequests.length === 0) return;

			const client = new OpenMeetIntakeClient(backend, fetchFn);
			// Failures are contained PER RECORD rather than per batch. Letting one
			// bad record throw out of onRecords would cost every record queued
			// behind it, and contrail does not retry the batch.
			const send = async (request: IntakeRequest) => {
				try {
					await client.send(request);
				} catch (err) {
					console.error('[openmeet-sink] intake call failed:', err);
				}
			};

			// TWO-PHASE DRAIN: every event in the batch is written before any RSVP
			// in it. The RSVP intake resolves its target event by source id and
			// hard-fails with 400 "Event with source ID ... not found" when the
			// event is not there yet — it does not queue or retry, and neither do
			// we, so a lost race silently drops the RSVP.
			//
			// One pool over the combined list loses that race routinely: `pooled`
			// starts MAX_IN_FLIGHT requests at once, so an RSVP sitting within the
			// first few entries is in flight alongside — or ahead of — the event it
			// depends on. Verified against a real openmeet-api on 2026-08-01: an
			// event plus its own RSVP in one batch produced 202 for the event and
			// 400 for the RSVP, and re-feeding the identical batch afterwards
			// succeeded precisely because the event existed by then.
			//
			// The legacy pipeline never hit this: RabbitMQ handed the processor one
			// message at a time in firehose order, which serialized the dependency
			// for free. Batching is what reintroduces it, and BACKFILL is where it
			// bites hardest — a profile view hands the sink a back catalogue in
			// which events and their RSVPs are interleaved.
			//
			// Ordering WITHIN each phase is still unconstrained, and deletes need no
			// ordering at all: removing an event clears its attendees, and an RSVP
			// delete for an already-gone row is a tolerated no-op either way.
			await pooled(eventRequests, MAX_IN_FLIGHT, send);
			await pooled(rsvpRequests, MAX_IN_FLIGHT, send);
		}
	};
}

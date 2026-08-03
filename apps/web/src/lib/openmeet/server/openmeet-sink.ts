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

/** How many times a THROTTLED (429) request is re-issued before it is dropped.
 *
 *  The intake API sits behind a global per-IP throttle — 100 requests per 60s in
 *  production, applied by an APP_GUARD that no route opts out of. Live ingest is
 *  nowhere near it (a cron tick carries single-digit records), but a backfill
 *  batch is: one profile-page view can hand this sink a whole back catalogue,
 *  which at MAX_IN_FLIGHT would blow the window in seconds.
 *
 *  Without a retry a 429 is indistinguishable from any other failure — logged,
 *  dropped, never revisited — which would silently hole exactly the backfill the
 *  feed exists to deliver. The legacy pipeline never needed this: RabbitMQ paced
 *  it to one message at a time, well under the limit. */
const MAX_RETRIES = 3;

/** Ceiling on a single backoff wait, in ms.
 *
 *  `Retry-After` from the throttler counts down the whole 60s window, and
 *  honouring that verbatim would park a cron invocation for a minute while the
 *  one-minute schedule keeps firing. Capping trades "this record definitely
 *  lands" for "the invocation stays bounded" — a capped retry that still 429s is
 *  dropped, same as before. */
const MAX_BACKOFF_MS = 10_000;

/** Raised when a request was throttled and exhausted its retries, as opposed to
 *  failing for a reason specific to that record. The batch uses it to stop
 *  issuing calls that are known to be doomed — see the drain in `onRecords`. */
export class IntakeThrottledError extends Error {}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Read `Retry-After` as milliseconds. Handles both wire forms — delta-seconds
 *  and an HTTP-date — and returns null when absent or unparseable, leaving the
 *  caller on its own backoff schedule. */
function retryAfterMs(res: Response): number | null {
	const raw = res.headers.get('retry-after');
	if (!raw) return null;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const when = Date.parse(raw);
	if (Number.isNaN(when)) return null;
	return Math.max(0, when - Date.now());
}

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

	/** Issue one intake request, retrying while it is throttled. Resolves on
	 *  success or a tolerated status; throws otherwise so the caller can log and
	 *  move on.
	 *
	 *  429 is the ONLY retried status. A 5xx is left as a plain failure the way
	 *  it always was: it is not obviously transient, retrying it costs the same
	 *  backfill budget, and widening the retry set is a behaviour change that
	 *  should be made deliberately rather than folded in here. */
	async send(request: IntakeRequest): Promise<void> {
		const query = request.query ? `?${new URLSearchParams(request.query)}` : '';
		const url = `${this.base}${request.path}${query}`;
		const init: RequestInit = {
			method: request.method,
			headers: {
				authorization: `Bearer ${this.apiKey}`,
				'content-type': 'application/json',
				'x-tenant-id': this.tenantId
			},
			body: request.body === undefined ? undefined : JSON.stringify(request.body)
		};
		// Call fetch detached rather than as `this.fetch(...)`: on workerd the
		// global fetch throws "Illegal invocation" when `this` is bound to a
		// non-global object, which method-call syntax would do. Node/undici is
		// lenient, so this only bites in the deployed Worker.
		const doFetch = this.fetch;

		for (let attempt = 0; ; attempt++) {
			const res = await doFetch(url, init);
			if (res.ok || request.tolerate.includes(res.status)) return;

			if (res.status === 429) {
				if (attempt >= MAX_RETRIES) {
					throw new IntakeThrottledError(
						`OpenMeet intake ${request.method} ${request.path} throttled after ${attempt + 1} attempts`
					);
				}
				// Server's own advice wins when it gives any; otherwise back off
				// exponentially from 250ms. Either way the cap applies.
				const advised = retryAfterMs(res);
				const backoff = advised ?? 2 ** attempt * 250;
				await sleep(Math.min(backoff, MAX_BACKOFF_MS));
				continue;
			}

			// No body echoed — it can carry record content or credentials into logs.
			throw new Error(`OpenMeet intake ${request.method} ${request.path} failed: ${res.status}`);
		}
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

/** One queued intake call, carried with the record it came from.
 *
 *  The transforms return bare `IntakeRequest` descriptors and deliberately stay
 *  in that business, so the source record's identity is not recoverable from a
 *  request alone: a create is a POST to a collection-level path with the at://
 *  URI buried in the body. Pairing them here — local to the dispatch loop,
 *  leaving the transform contract untouched — is what lets a failure name the
 *  record it lost. Without it a failed call is unattributable and the record
 *  cannot be re-fed by hand. */
interface PendingCall {
	request: IntakeRequest;
	uri: string;
}

/** Render a caught value for a log line.
 *
 *  `console.error('msg:', err)` is NOT equivalent: on workerd that renders the
 *  STACK and drops `err.message`, so a thrown Error carrying the HTTP status
 *  logs as "intake call failed:" followed by frames and nothing else. That is
 *  exactly how two real prod failures (2026-08-02 17:21Z and 18:45Z) became
 *  undiagnosable — the status was in the message the whole time and never
 *  reached the log. Interpolate the message explicitly instead. */
function errorDetail(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
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
			const eventRequests: PendingCall[] = [];
			const rsvpRequests: PendingCall[] = [];
			for (const e of events) {
				let result: TransformResult;
				let target: PendingCall[];
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
				target.push({ request: result.request, uri: e.uri });
			}

			if (eventRequests.length === 0 && rsvpRequests.length === 0) return;

			const client = new OpenMeetIntakeClient(backend, fetchFn);

			// Once a request has burned all its retries against the throttle, the
			// rest of this batch is abandoned rather than issued. The window is
			// measured in whole minutes and we have already backed off across it,
			// so the queued calls would fail too — this drops the same records
			// while wasting neither the throttle budget nor the invocation, and it
			// bounds the worst case at one exhausted retry chain instead of one
			// per record. Batch-scoped deliberately: the next tick starts clean.
			let throttled = false;

			// Failures are otherwise contained PER RECORD rather than per batch.
			// Letting one bad record throw out of onRecords would cost every record
			// queued behind it, and contrail does not retry the batch.
			const send = async ({ request, uri }: PendingCall) => {
				if (throttled) return;
				try {
					await client.send(request);
				} catch (err) {
					if (err instanceof IntakeThrottledError) {
						// Logged once per batch, not once per abandoned record.
						if (!throttled) {
							throttled = true;
							console.error(
								`[openmeet-sink] throttled by intake API, abandoning batch at ${uri}: ${errorDetail(err)}`
							);
						}
						return;
					}
					// Name the record AND the status. This record is now dropped for
					// good — there is no retry outside 429 and no dead-letter path —
					// so the log line is the only trace that it existed, and the only
					// way to re-feed it by hand. The response BODY stays out
					// deliberately: it can carry record content or credentials, and
					// the status plus the URI is what makes a failure actionable.
					console.error(`[openmeet-sink] intake call failed for ${uri}: ${errorDetail(err)}`);
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
			//
			// If the event phase trips the throttle breaker the RSVP phase is
			// skipped wholesale, which is the outcome we want rather than a side
			// effect to work around: those RSVPs' events did not land, so every one
			// of them would 400 on the missing-event path anyway.
			await pooled(eventRequests, MAX_IN_FLIGHT, send);
			await pooled(rsvpRequests, MAX_IN_FLIGHT, send);
		}
	};
}

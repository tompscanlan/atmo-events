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
// ./rsvp-transform, which are pure and import nothing from atmo or contrail;
// ./parent-record joins them under the same rule — it performs HTTP, but only
// through an injected fetch and only against the public atproto network. This
// file is the only part that knows about atmo or contrail at all — so lifting
// the set into an out-of-process consumer (a generic webhook sink pointed at a
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
import { fetchParentRecord } from './parent-record';

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

/** Why the intake API refused a write, reduced to a closed set.
 *
 *  The two that matter both arrive as a bare HTTP 400 on
 *  `/api/integration/rsvps` and are opposites:
 *
 *    - `parent-missing` is a REAL LOSS. The RSVP's event is not in the platform,
 *      so there is nothing to attach an attendance record to. Recoverable — see
 *      the repair path in `onRecords`.
 *    - `duplicate-key` is a SUCCESS wearing a failure's clothes. The attendance
 *      row already exists (openmeet-api holds
 *      `UNIQUE ("eventId","userId")` on `eventAttendees`), which is the end state
 *      an idempotent feed wants. Counting it as a drop is what put the observed
 *      drop rate an order of magnitude above the real one during the two-writer
 *      soak: 11 of 12 drops in the 2026-08-05 window were this. */
export type IntakeRefusalReason = 'parent-missing' | 'duplicate-key' | 'unclassified';

/** A refusal the sink was able to attribute. Carries the reason as a FIELD
 *  rather than in the message, so the caller can branch on it while the log line
 *  stays a bounded token. */
export class IntakeRefusedError extends Error {
	readonly reason: IntakeRefusalReason;

	constructor(message: string, reason: IntakeRefusalReason) {
		super(message);
		this.reason = reason;
	}
}

/** How much of a refusal body is scanned. NestJS puts `message` first, so the
 *  distinguishing text is at the front; the bound is here so a pathological
 *  response cannot turn classification into work. */
const MAX_CLASSIFY_CHARS = 4096;

/** Reduce a refusal body to a reason code.
 *
 *  THE BODY IS AN INPUT AND NEVER AN OUTPUT. Its content is matched against
 *  fixed patterns and then discarded; the only thing that escapes this function
 *  is a member of `IntakeRefusalReason`. That is what lets the sink gain the one
 *  bit it needs while keeping the property the DROP log was built around — a
 *  response body can carry record content or credentials and must not reach a
 *  log line.
 *
 *  The patterns match openmeet-api's own wording: the RSVP intake service throws
 *  `Event with source ID ${uri} not found` (rsvp-integration.service.ts) which
 *  its controller wraps into a 400, and a unique-constraint violation surfaces
 *  as Postgres' verbatim message through the same wrapper. */
function classifyRefusal(body: string): IntakeRefusalReason {
	const head = body.slice(0, MAX_CLASSIFY_CHARS);
	if (/event with source id[\s\S]*?not found/i.test(head)) return 'parent-missing';
	if (/duplicate key value violates unique constraint/i.test(head)) return 'duplicate-key';
	return 'unclassified';
}

/** Read a response body for classification, tolerating a body that is absent,
 *  already consumed, or unreadable — an unclassifiable refusal is the status quo
 *  and must never become a thrown error of its own. */
async function bodyForClassification(res: Response): Promise<string> {
	try {
		return await res.text();
	} catch {
		return '';
	}
}

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
			// It IS read here, and reduced to a reason code before anything else
			// sees it: classifying at the source is what makes a drop
			// self-explaining. Without it, telling a real loss from a duplicate
			// takes a session of archaeology across two databases, which is
			// precisely what the 2026-08-05 split cost.
			//
			// Only a 400 is classified. Every distinguishable refusal the intake
			// API makes is one, and reading a 5xx body would be scanning an error
			// page for something that was never going to be in it.
			const reason =
				res.status === 400 ? classifyRefusal(await bodyForClassification(res)) : 'unclassified';
			throw new IntakeRefusedError(
				`OpenMeet intake ${request.method} ${request.path} failed: ${res.status}`,
				reason
			);
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
	/** For an RSVP create, the at:// URI of the event it attaches to.
	 *
	 *  Read back off the built request rather than threaded out of the transform:
	 *  `rsvp-transform` has already read the record's `subject` in both its wire
	 *  shapes, rejected anything that is not a well-formed at:// URI, and put the
	 *  survivor in the body as `eventSourceId`. Lifting it from there keeps the
	 *  transform contract — a request descriptor, nothing more — exactly as it
	 *  was, and keeps this knowledge local to the dispatch loop that needs it. */
	parentUri?: string;
}

/** The event an RSVP create names as its subject, if this request is one. */
function parentUriOf(request: IntakeRequest): string | undefined {
	if (request.method !== 'POST') return undefined;
	const body = request.body as { eventSourceId?: unknown } | undefined;
	return typeof body?.eventSourceId === 'string' ? body.eventSourceId : undefined;
}

/** Marker prefixing every line that reports a record this sink DROPPED — one
 *  atmo held and OpenMeet would not take. One line, one lost record, always
 *  carrying `uri=` and `cause=`.
 *
 *  It exists to be GREPPED, not just read. There is no dead-letter table by
 *  design, so the log is the whole record of what was lost, and the count has to
 *  be exact: `[openmeet-sink]` alone also matches successes-adjacent noise and
 *  the `skipping` transform warnings, which are a different failure class
 *  (malformed record, never offered to OpenMeet) and must not inflate a drop
 *  tally. The `cloudflare/atmo/soak-check.py` sweep in openmeet-infrastructure
 *  parses these two markers; treat the format as a contract with it, which is
 *  why the tests assert the literal strings rather than these constants. */
const DROP_LOG = '[openmeet-sink] DROP';

/** Companion to DROP_LOG for records lost WITHOUT being individually named:
 *  once the throttle breaker trips, the rest of the batch is abandoned unissued.
 *  Emitted once per batch carrying `abandoned=<n>`, so the tally stays honest
 *  even though those records' identities are not recoverable. A drop total is
 *  therefore (DROP lines) + (sum of abandoned=), never the line count alone. */
const DROP_BATCH_LOG = '[openmeet-sink] DROP-BATCH';

/** A record that was refused and then LANDED after its parent event was fetched
 *  and fed. The counterpart to DROP: same grep discipline, opposite meaning.
 *
 *  It deliberately does NOT contain the substring `[openmeet-sink] DROP`, which
 *  is what the soak sweep counts losses by — a repair is the absence of a loss,
 *  and must not show up in that tally. It lands in the sweep's "other sink
 *  lines" bucket instead, where a rising count is the mechanism working. */
const REPAIRED_LOG = '[openmeet-sink] REPAIRED';

/** A write refused because the row it would create is already there.
 *
 *  Also not a DROP, and for the same reason: the end state an idempotent feed
 *  wanted holds. Logged rather than swallowed because the count IS the
 *  measurement of how much the two writers are colliding — it should fall to
 *  zero once the legacy pipeline is scaled to 0, and if it does not, something
 *  else is writing.
 *
 *  CAVEAT, deliberate: this trusts that a unique-violation on the RSVP path is
 *  the attendee row's `UNIQUE ("eventId","userId")`. A violation raised further
 *  up — two RSVPs from the same previously-unseen DID racing to create one
 *  shadow account, which `MAX_IN_FLIGHT` makes possible within a single batch —
 *  would be a genuine loss recorded here as a success. That is the trade this
 *  marker exists to keep visible: the line is greppable and countable, so the
 *  case shows up as a persistent non-zero count rather than as silence. */
const ALREADY_PRESENT_LOG = '[openmeet-sink] ALREADY-PRESENT';

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
			//     fact that there is largely no retry: outside the throttle path
			//     and the parent repair below, a record whose POST fails is simply
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
				target.push({
					request: result.request,
					uri: e.uri,
					parentUri: target === rsvpRequests ? parentUriOf(result.request) : undefined
				});
			}

			if (eventRequests.length === 0 && rsvpRequests.length === 0) return;

			const client = new OpenMeetIntakeClient(backend, fetchFn);
			// The repair path talks to plc.directory and a PDS rather than to
			// OpenMeet, so it goes around the intake client — but through the same
			// injected fetch, which is why no new seam is needed to reach it.
			const doFetch = fetchFn ?? globalThis.fetch;

			// Once a request has burned all its retries against the throttle, the
			// rest of this batch is abandoned rather than issued. The window is
			// measured in whole minutes and we have already backed off across it,
			// so the queued calls would fail too — this drops the same records
			// while wasting neither the throttle budget nor the invocation, and it
			// bounds the worst case at one exhausted retry chain instead of one
			// per record. Batch-scoped deliberately: the next tick starts clean.
			let throttled = false;

			// Records lost to the breaker WITHOUT a line naming them: the ones that
			// exhausted their own retries after the first (the pool runs
			// MAX_IN_FLIGHT of them concurrently, so several can be mid-chain when
			// the breaker trips) plus every one never issued afterwards. Counting
			// them is what keeps a drop tally from reading as 1 when it is 8 —
			// silently under-reporting a loss is the whole defect this sink is
			// being hardened against.
			let abandoned = 0;

			// Trip the breaker on the first exhausted retry chain and name the record
			// that tripped it; everything after is counted, not named.
			const noteThrottled = (uri: string, err: IntakeThrottledError) => {
				if (!throttled) {
					throttled = true;
					console.error(`${DROP_LOG} uri=${uri} cause=throttled ${errorDetail(err)}`);
					return;
				}
				abandoned++;
			};

			/** Repair a `parent-missing` RSVP: fetch the event it names from its
			 *  author's PDS, feed it, and re-offer the RSVP ONCE.
			 *
			 *  This is what makes the sink survivable as the ONLY writer. Two
			 *  distinct things put an RSVP here, and only this fixes both:
			 *
			 *    - CROSS-BATCH ordering. The parent is on its way and will land in a
			 *      later cycle. (Within one batch it cannot happen: the two-phase
			 *      drain below writes every event before any RSVP.) Waiting would
			 *      eventually work; fetching works now.
			 *    - A GAP parent. The event predates anything the sink or any backfill
			 *      ever fed — the one confirmed real loss in the 2026-08-05 window
			 *      named an event five months old. Waiting NEVER works. This is the
			 *      only mechanism short of a bulk reconcile that touches it at all,
			 *      and it drains those parents on demand as a side effect.
			 *
			 *  BOUNDED BY CONSTRUCTION. It issues its writes through `client.send`
			 *  directly rather than through `send` below, so a failure here cannot
			 *  re-enter the repair path: one attempt, then the record is dropped
			 *  exactly as it would have been. */
			const repairParent = async (call: PendingCall, parentUri: string, refusal: Error) => {
				// The breaker may have tripped while this record was in flight. Two
				// more requests would be spent on an intake that is already refusing
				// everything, so drop it as the plain refusal it was.
				if (throttled) {
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=intake-failed reason=parent-missing ${errorDetail(refusal)}`
					);
					return;
				}

				const lookup = await fetchParentRecord(parentUri, doFetch);
				if (lookup.kind === 'unavailable') {
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=parent-unavailable parent=${parentUri} reason=${lookup.reason}`
					);
					return;
				}

				// Through the EXISTING transform, not a second mapping of the same
				// lexicon. A record it rejects (a missing or unparseable start date is
				// the real case) gives up here — one line, no malformed POST.
				const transformed = eventRequestFor(lookup.event);
				if (transformed.kind === 'skip') {
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=parent-untransformable parent=${parentUri} reason=${transformed.reason}`
					);
					return;
				}

				try {
					await client.send(transformed.request);
				} catch (err) {
					if (err instanceof IntakeThrottledError) {
						noteThrottled(call.uri, err);
						return;
					}
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=parent-feed-failed parent=${parentUri} ${errorDetail(err)}`
					);
					return;
				}

				try {
					await client.send(call.request);
				} catch (err) {
					if (err instanceof IntakeThrottledError) {
						noteThrottled(call.uri, err);
						return;
					}
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=intake-failed reason=retry-still-failed parent=${parentUri} ${errorDetail(err)}`
					);
					return;
				}

				console.warn(`${REPAIRED_LOG} uri=${call.uri} parent=${parentUri}`);
			};

			/** Decide what a failed intake call means and record it. */
			const onFailure = async (err: unknown, call: PendingCall) => {
				if (err instanceof IntakeThrottledError) {
					noteThrottled(call.uri, err);
					return;
				}

				if (err instanceof IntakeRefusedError) {
					// The row is already there. Not a loss, so not a DROP — but said
					// out loud, because the count is how hard the two writers are
					// colliding.
					if (err.reason === 'duplicate-key') {
						console.warn(`${ALREADY_PRESENT_LOG} uri=${call.uri} reason=duplicate-key`);
						return;
					}
					if (err.reason === 'parent-missing' && call.parentUri) {
						await repairParent(call, call.parentUri, err);
						return;
					}
					console.error(
						`${DROP_LOG} uri=${call.uri} cause=intake-failed reason=${err.reason} ${errorDetail(err)}`
					);
					return;
				}

				// Name the record AND the status. This record is now dropped for
				// good — there is no retry outside 429 and no dead-letter path —
				// so the log line is the only trace that it existed, and the only
				// way to re-feed it by hand. The response BODY stays out
				// deliberately: it can carry record content or credentials, and
				// the status plus the URI is what makes a failure actionable.
				console.error(
					`${DROP_LOG} uri=${call.uri} cause=intake-failed reason=unclassified ${errorDetail(err)}`
				);
			};

			// Failures are otherwise contained PER RECORD rather than per batch.
			// Letting one bad record throw out of onRecords would cost every record
			// queued behind it, and contrail does not retry the batch.
			const send = async (call: PendingCall) => {
				if (throttled) {
					abandoned++;
					return;
				}
				try {
					await client.send(call.request);
				} catch (err) {
					await onFailure(err, call);
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

			// Report the unnamed losses once the batch is settled, so both drain
			// phases are accounted for in a single number. Only the count survives —
			// these records were never issued, so there is nothing to name — but a
			// count is the difference between "one record was throttled" and "one
			// record was throttled and 295 more went with it".
			if (abandoned > 0) {
				console.error(`${DROP_BATCH_LOG} abandoned=${abandoned} cause=throttled`);
			}
		}
	};
}

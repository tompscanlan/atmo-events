import { describe, it, expect, vi, afterEach } from 'vitest';
import {
	createOpenMeetSink,
	openMeetSinkBackendFromEnv,
	type OpenMeetSinkBackend
} from './openmeet-sink';
import { EVENT_COLLECTION, RSVP_COLLECTION } from './types';

const BACKEND: OpenMeetSinkBackend = {
	url: 'https://api.openmeet.test',
	apiKey: 'service-key',
	tenantId: 'tenant_test'
};

const DID = 'did:plc:alice';

/** A fetch double that records calls and returns a scripted status per call. */
function fakeFetch(statuses: number[] = []) {
	const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] =
		[];
	let n = 0;
	const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		calls.push({
			url: String(input),
			method: init?.method ?? 'GET',
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body ? JSON.parse(String(init.body)) : undefined
		});
		return new Response(null, { status: statuses[n++] ?? 202 });
	});
	return { fn: fn as unknown as typeof fetch, calls };
}

function eventRecord(rkey: string, record: Record<string, unknown>) {
	return {
		kind: 'created' as const,
		uri: `at://${DID}/${EVENT_COLLECTION}/${rkey}`,
		did: DID,
		collection: EVENT_COLLECTION,
		rkey,
		cid: 'bafycid',
		record,
		time_us: 1_700_000_000_000_000
	};
}

const VALID_EVENT = { name: 'Test Event', startsAt: '2026-10-20T18:00:00Z' };

type Sink = ReturnType<typeof createOpenMeetSink>;
type Ctx = Parameters<Sink['onRecords']>[1];
const LIVE: Ctx = { phase: 'live' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const onRecords = (sink: Sink, events: any[], ctx: Ctx = LIVE) => sink.onRecords(events, ctx);

afterEach(() => {
	vi.restoreAllMocks();
});

describe('openMeetSinkBackendFromEnv', () => {
	it('resolves a fully configured backend', () => {
		expect(
			openMeetSinkBackendFromEnv({
				OPENMEET_SINK_URL: 'https://api.openmeet.test',
				OPENMEET_SINK_API_KEY: 'service-key',
				OPENMEET_SINK_TENANT_ID: 'tenant_test'
			})
		).toEqual(BACKEND);
	});

	// The property that keeps a dev or preview instance from feeding production:
	// no URL, no sink, no warning needed — that is the ordinary state.
	it('returns null when the url is unset, silently', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(openMeetSinkBackendFromEnv({})).toBeNull();
		expect(openMeetSinkBackendFromEnv(undefined)).toBeNull();
		expect(warn).not.toHaveBeenCalled();
	});

	it('warns and disables when configured with a url but no key', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			openMeetSinkBackendFromEnv({
				OPENMEET_SINK_URL: 'https://api.openmeet.test',
				OPENMEET_SINK_TENANT_ID: 'tenant_test'
			})
		).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
	});

	it('warns and disables when configured with a url but no tenant', () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(
			openMeetSinkBackendFromEnv({
				OPENMEET_SINK_URL: 'https://api.openmeet.test',
				OPENMEET_SINK_API_KEY: 'service-key'
			})
		).toBeNull();
		expect(warn).toHaveBeenCalledOnce();
	});
});

describe('createOpenMeetSink', () => {
	it('is inert when no backend is armed', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => null, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(calls).toHaveLength(0);
	});

	it('ignores collections it does not feed', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[{ ...eventRecord('a', VALID_EVENT), collection: 'app.bsky.feed.post' }]
		);
		expect(calls).toHaveLength(0);
	});

	it('sends auth and tenant headers on every call', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(calls[0].headers).toMatchObject({
			authorization: 'Bearer service-key',
			'content-type': 'application/json',
			'x-tenant-id': 'tenant_test'
		});
	});

	it('POSTs an event create to the intake endpoint', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe('POST');
		expect(calls[0].url).toBe('https://api.openmeet.test/api/integration/events');
		expect(calls[0].body).toMatchObject({ name: 'Test Event' });
	});

	it('POSTs an rsvp create to the rsvps endpoint', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[
				{
					...eventRecord('a', {
						subject: { uri: 'at://did:plc:bob/community.lexicon.calendar.event/3k' },
						status: 'going'
					}),
					collection: RSVP_COLLECTION
				}
			]
		);
		expect(calls[0].url).toBe('https://api.openmeet.test/api/integration/rsvps');
	});

	it('routes a delete to the atproto path with the sourceType query', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[
				{
					kind: 'deleted',
					uri: `at://${DID}/${EVENT_COLLECTION}/a`,
					did: DID,
					collection: EVENT_COLLECTION,
					rkey: 'a'
				}
			]
		);
		expect(calls[0].method).toBe('DELETE');
		expect(calls[0].url).toBe(
			`https://api.openmeet.test/api/integration/events/atproto/${DID}/${EVENT_COLLECTION}/a?sourceType=bluesky`
		);
	});

	it('strips a trailing slash from the configured base url', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => ({ ...BACKEND, url: 'https://api.openmeet.test/' }), fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(calls[0].url).toBe('https://api.openmeet.test/api/integration/events');
	});

	it('logs and drops a malformed record without calling the API', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', { name: 'No date' })]
		);
		expect(calls).toHaveLength(0);
		expect(warn).toHaveBeenCalledOnce();
	});
});

describe('createOpenMeetSink — failure handling', () => {
	it('treats a 409 on create as success', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([409]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(error).not.toHaveBeenCalled();
	});

	it('treats a 404 on delete as success — already gone is the end state we wanted', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([404]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[
				{
					kind: 'deleted',
					uri: `at://${DID}/${EVENT_COLLECTION}/a`,
					did: DID,
					collection: EVENT_COLLECTION,
					rkey: 'a'
				}
			]
		);
		expect(error).not.toHaveBeenCalled();
	});

	it('does not tolerate a 404 on create', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([404]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(error).toHaveBeenCalledOnce();
	});

	it('logs a server error instead of throwing, so contrail ingest is unaffected', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await expect(
			onRecords(
				createOpenMeetSink(() => BACKEND, fn),
				[eventRecord('a', VALID_EVENT)]
			)
		).resolves.toBeUndefined();
		expect(error).toHaveBeenCalledOnce();
	});

	// These three pin the fix for the 2026-08-02 prod incident: two real intake
	// failures logged as "[openmeet-sink] intake call failed:" plus a stack and
	// NOTHING else. The status was in the thrown Error's message all along, but
	// `console.error('label:', err)` renders the stack on workerd and drops the
	// message — so neither the cause nor the identity of the two lost records was
	// recoverable. A dropped record has no retry and no dead-letter path, so this
	// log line is the only trace it ever existed.
	it('puts the HTTP status in the logged message, not just in a stack', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(error).toHaveBeenCalledOnce();
		expect(String(error.mock.calls[0][0])).toContain('500');
	});

	it('names the record that was lost, so it can be re-fed by hand', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('doomed', VALID_EVENT)]
		);
		expect(String(error.mock.calls[0][0])).toContain(`at://${DID}/${EVENT_COLLECTION}/doomed`);
	});

	// The crux: one already-rendered string argument. Passing the Error as a
	// second argument is what made the message vanish in the deployed Worker,
	// and a test that only checked "console.error was called" passed throughout.
	it('logs a single rendered string rather than handing console an Error object', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(error.mock.calls[0]).toHaveLength(1);
		expect(error.mock.calls[0][0]).toBeTypeOf('string');
	});

	it('never echoes the response body or the key into the error', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain('service-key');
	});

	// These pin the DROP log FORMAT, which is a contract with an out-of-repo
	// consumer: cloudflare/atmo/soak-check.py in openmeet-infrastructure counts
	// drops by grepping these exact markers, and that count is what gates scaling
	// the legacy pipeline to 0. There is no dead-letter table by design, so the
	// log line IS the record of the loss. They deliberately assert the literal
	// strings rather than importing the constants — asserting the constant would
	// let a rename sail through green while silently blinding the sweep.
	it('marks a dropped record with the grep marker, its uri and its cause', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('doomed', VALID_EVENT)]
		);
		const line = String(error.mock.calls[0][0]);
		expect(line.startsWith('[openmeet-sink] DROP ')).toBe(true);
		expect(line).toContain(`uri=at://${DID}/${EVENT_COLLECTION}/doomed`);
		expect(line).toContain('cause=intake-failed');
	});

	it('distinguishes a throttled drop from a refused one by cause', async () => {
		vi.useFakeTimers();
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = vi.fn(async () => new Response(null, { status: 429 })) as unknown as typeof fetch;

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('doomed', VALID_EVENT)]
		);
		await vi.runAllTimersAsync();
		await done;
		vi.useRealTimers();

		const line = String(error.mock.calls[0][0]);
		expect(line.startsWith('[openmeet-sink] DROP ')).toBe(true);
		expect(line).toContain('cause=throttled');
		expect(line).toContain(`uri=at://${DID}/${EVENT_COLLECTION}/doomed`);
	});

	// A malformed record is a TRANSFORM gap, not OpenMeet refusing a write — it
	// is never offered to the intake API at all. It must not carry the drop
	// marker, or the sweep's tally conflates two unrelated failure classes and
	// over-reports what the platform actually lost.
	it('does not mark a malformed record as a drop', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const { fn } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('bad', { name: 'No date' })]
		);
		expect(warn).toHaveBeenCalledOnce();
		expect(JSON.stringify(error.mock.calls)).not.toContain('[openmeet-sink] DROP');
	});

	// One bad record must not cost the records queued behind it: contrail does
	// not retry the batch, so anything dropped here is dropped for good.
	it('contains a failure to its own record and still delivers the rest', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn, calls } = fakeFetch([500, 202, 202]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT), eventRecord('b', VALID_EVENT), eventRecord('c', VALID_EVENT)]
		);
		expect(calls).toHaveLength(3);
	});
});

describe('createOpenMeetSink — ingest phase', () => {
	// A considered decision, not an oversight: backfill batches reach the LIVE
	// Worker (contrail lazily backfills an actor when an xrpc query names them,
	// so a profile-page view can deliver a whole back catalogue), and feeding
	// them is how the platform's historical gap closes. The intake API is
	// idempotent by source id, so a re-send updates rather than duplicates.
	it('feeds backfill batches exactly like live ones', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)],
			{ phase: 'backfill' }
		);
		expect(calls).toHaveLength(1);
	});
});

describe('createOpenMeetSink — event/RSVP dispatch ordering', () => {
	function rsvpRecord(rkey: string, eventRkey: string) {
		return {
			kind: 'created' as const,
			uri: `at://${DID}/${RSVP_COLLECTION}/${rkey}`,
			did: DID,
			collection: RSVP_COLLECTION,
			rkey,
			cid: 'bafycid',
			record: {
				subject: { uri: `at://${DID}/${EVENT_COLLECTION}/${eventRkey}` },
				status: 'going',
				createdAt: '2026-08-01T12:00:00.000Z'
			},
			time_us: 1_700_000_000_000_000
		};
	}

	/** Flush pending microtasks + timers so in-flight fetches can settle. */
	const settle = () => new Promise((r) => setTimeout(r, 0));

	// The RSVP intake resolves its target event by source id and returns 400
	// "Event with source ID ... not found" when the event has not landed yet.
	// Neither side retries, so an RSVP that overtakes its event is dropped for
	// good. Confirmed against a real openmeet-api on 2026-08-01.
	it('completes every event write before issuing any RSVP write', async () => {
		const order: string[] = [];
		let releaseEvents!: () => void;
		const eventsGate = new Promise<void>((resolve) => {
			releaseEvents = resolve;
		});

		const fn = vi.fn(async (input: RequestInfo | URL) => {
			const isRsvp = String(input).includes('/api/integration/rsvps');
			order.push(isRsvp ? 'rsvp' : 'event');
			if (!isRsvp) await eventsGate;
			return new Response(null, { status: 202 });
		}) as unknown as typeof fetch;

		// Interleaved, with RSVPs early enough that a single pool would start
		// them alongside the events they depend on.
		const batch = [
			rsvpRecord('r1', 'e1'),
			eventRecord('e1', VALID_EVENT),
			rsvpRecord('r2', 'e2'),
			eventRecord('e2', VALID_EVENT),
			eventRecord('e3', VALID_EVENT)
		];

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			batch
		);
		await settle();

		// Events are still in flight, so not one RSVP may have been issued.
		expect(order).toEqual(['event', 'event', 'event']);

		releaseEvents();
		await done;

		expect(order).toEqual(['event', 'event', 'event', 'rsvp', 'rsvp']);
	});

	it('still writes RSVPs when a batch carries no events', async () => {
		const { fn, calls } = fakeFetch();
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[rsvpRecord('r1', 'e1')]
		);
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toContain('/api/integration/rsvps');
	});
});

// The intake API is behind a global per-IP throttle (100 req / 60s in prod)
// that no route opts out of. Live ticks are nowhere near it; a backfill batch
// is, and an unretried 429 would silently drop exactly the records the backfill
// exists to deliver.
describe('createOpenMeetSink — throttling', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	function rsvpRecord(rkey: string, eventRkey: string) {
		return {
			kind: 'created' as const,
			uri: `at://${DID}/${RSVP_COLLECTION}/${rkey}`,
			did: DID,
			collection: RSVP_COLLECTION,
			rkey,
			cid: 'bafycid',
			record: {
				subject: { uri: `at://${DID}/${EVENT_COLLECTION}/${eventRkey}` },
				status: 'going',
				createdAt: '2026-08-01T12:00:00.000Z'
			},
			time_us: 1_700_000_000_000_000
		};
	}

	/** A fetch double returning 429 for the first `n` calls, then 202. Optionally
	 *  attaches a Retry-After to the throttled responses. */
	function throttling(n: number, retryAfter?: string) {
		let calls = 0;
		const fn = vi.fn(async () => {
			calls++;
			if (calls <= n) {
				return new Response(null, {
					status: 429,
					headers: retryAfter ? { 'retry-after': retryAfter } : undefined
				});
			}
			return new Response(null, { status: 202 });
		});
		return fn as unknown as typeof fetch;
	}

	it('retries a throttled write and succeeds, rather than dropping the record', async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = throttling(1);

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('e1', VALID_EVENT)]
		);
		await vi.runAllTimersAsync();
		await done;

		expect(fn).toHaveBeenCalledTimes(2);
		expect(errors).not.toHaveBeenCalled();
	});

	it('waits the server-advised Retry-After instead of its own backoff', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = throttling(1, '5'); // 5 seconds, vs a 250ms default first backoff

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('e1', VALID_EVENT)]
		);

		await vi.advanceTimersByTimeAsync(4000);
		expect(fn).toHaveBeenCalledTimes(1); // still honouring the advice

		await vi.advanceTimersByTimeAsync(1500);
		expect(fn).toHaveBeenCalledTimes(2);
		await done;
	});

	it('caps an extravagant Retry-After so one batch cannot park the invocation', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = throttling(1, '600'); // 10 minutes; MAX_BACKOFF_MS is 10s

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('e1', VALID_EVENT)]
		);

		await vi.advanceTimersByTimeAsync(9000);
		expect(fn).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(2000);
		expect(fn).toHaveBeenCalledTimes(2);
		await done;
	});

	it('gives up after a bounded number of attempts and reports it as throttling', async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = throttling(Infinity);

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('e1', VALID_EVENT)]
		);
		await vi.runAllTimersAsync();
		await done;

		expect(fn).toHaveBeenCalledTimes(4); // initial + MAX_RETRIES
		expect(errors).toHaveBeenCalledTimes(1);
		expect(errors.mock.calls[0][0]).toContain('throttled');
		// Was: expect(calls[0][1]).toBeInstanceOf(IntakeThrottledError) — which
		// pinned the Error being passed as a SECOND console argument, the exact
		// shape that renders as a bare stack on workerd and drops the message.
		// Asserting the rendered text instead keeps the intent (throttling is
		// reported distinctly) and additionally proves the detail survives.
		expect(errors.mock.calls[0]).toHaveLength(1);
		expect(errors.mock.calls[0][0]).toContain('attempts');
	});

	it('abandons the rest of the batch once throttling is established', async () => {
		vi.useFakeTimers();
		const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
		const fn = throttling(Infinity);

		// Eight events against a pool of four: the first four exhaust their
		// retries concurrently, and the remaining four must never be issued.
		const batch = Array.from({ length: 8 }, (_, i) => eventRecord(`e${i}`, VALID_EVENT));
		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			batch
		);
		await vi.runAllTimersAsync();
		await done;

		expect(fn).toHaveBeenCalledTimes(16); // 4 in flight x 4 attempts, then nothing

		// Two lines, not eight: one NAMES the record that tripped the breaker, and
		// one COUNTS everything that went down with it — the three that exhausted
		// their retries concurrently plus the four never issued. Was
		// `toHaveBeenCalledTimes(1)`, which passed while seven of the eight lost
		// records left no trace at all; a drop tally built on that read 1.
		expect(errors).toHaveBeenCalledTimes(2);
		expect(errors.mock.calls[1][0]).toContain('[openmeet-sink] DROP-BATCH');
		expect(errors.mock.calls[1][0]).toContain('abandoned=7');
	});

	it('skips the RSVP phase when the event phase was throttled', async () => {
		vi.useFakeTimers();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const urls: string[] = [];
		const fn = vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response(null, { status: 429 });
		}) as unknown as typeof fetch;

		const done = onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('e1', VALID_EVENT), rsvpRecord('r1', 'e1')]
		);
		await vi.runAllTimersAsync();
		await done;

		// Their event never landed, so every one of those RSVPs would 400 anyway.
		expect(urls).toHaveLength(4);
		expect(urls.every((u) => u.includes('/api/integration/events'))).toBe(true);
	});
});

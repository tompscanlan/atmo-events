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

	it('never echoes the response body or the key into the error', async () => {
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { fn } = fakeFetch([500]);
		await onRecords(
			createOpenMeetSink(() => BACKEND, fn),
			[eventRecord('a', VALID_EVENT)]
		);
		expect(JSON.stringify(error.mock.calls)).not.toContain('service-key');
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

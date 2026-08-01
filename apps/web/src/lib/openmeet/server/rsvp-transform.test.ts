// Coverage for the RSVP transform. Written rather than ported — see the header
// of ./event-transform.test.ts for why the upstream "spec suites" carry nothing
// worth porting.
import { describe, it, expect } from 'vitest';
import { normalizeRsvpStatus, rsvpRequestFor } from './rsvp-transform';
import { EVENT_COLLECTION, RSVP_COLLECTION, type SinkRecordEvent } from './types';

const DID = 'did:plc:alice';
const RKEY = '3krsvp';
const URI = `at://${DID}/${RSVP_COLLECTION}/${RKEY}`;
const EVENT_URI = 'at://did:plc:bob/community.lexicon.calendar.event/3kevent';
const TIME_US = 1_700_000_000_000_000;

function created(record: Record<string, unknown>): SinkRecordEvent {
	return {
		kind: 'created',
		uri: URI,
		did: DID,
		collection: RSVP_COLLECTION,
		rkey: RKEY,
		cid: 'bafycid',
		record,
		time_us: TIME_US
	};
}

/** The minimum a well-formed RSVP needs: a subject and a status. */
const MINIMAL = {
	subject: { uri: EVENT_URI, cid: 'bafyevent' },
	status: 'community.lexicon.calendar.rsvp#going'
};

function bodyFor(record: Record<string, unknown>) {
	const result = rsvpRequestFor(created(record));
	if (result.kind !== 'request') throw new Error(`expected a request, got skip: ${result.reason}`);
	// Arbitrary JSON the assertions walk into freely — see event-transform.test.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return result.request.body as Record<string, any>;
}

function skipReason(record: Record<string, unknown>) {
	const result = rsvpRequestFor(created(record));
	if (result.kind !== 'skip') throw new Error('expected a skip');
	return result.reason;
}

describe('normalizeRsvpStatus', () => {
	it('strips the lexicon NSID prefix', () => {
		expect(normalizeRsvpStatus('community.lexicon.calendar.rsvp#going')).toBe('going');
	});

	it('passes a bare short form through unchanged', () => {
		expect(normalizeRsvpStatus('interested')).toBe('interested');
	});

	it('defaults to interested when absent or not a string', () => {
		expect(normalizeRsvpStatus(undefined)).toBe('interested');
		expect(normalizeRsvpStatus('')).toBe('interested');
		expect(normalizeRsvpStatus(42)).toBe('interested');
	});
});

describe('rsvpRequestFor — creates', () => {
	it('POSTs to the rsvps intake endpoint, tolerating a racing 409', () => {
		const result = rsvpRequestFor(created(MINIMAL));
		if (result.kind !== 'request') throw new Error('expected a request');
		expect(result.request.method).toBe('POST');
		expect(result.request.path).toBe('/api/integration/rsvps');
		expect(result.request.tolerate).toEqual([409]);
	});

	it('builds the payload, keying the rsvp on its own at:// URI', () => {
		const body = bodyFor({ ...MINIMAL, createdAt: '2026-10-01T09:00:00Z' });
		expect(body).toMatchObject({
			eventSourceId: EVENT_URI,
			eventSourceType: 'bluesky',
			userDid: DID,
			status: 'going',
			timestamp: '2026-10-01T09:00:00Z',
			sourceId: URI
		});
	});

	it('carries identity metadata and the subject cid, but no commit rev', () => {
		const body = bodyFor(MINIMAL);
		expect(body.metadata).toEqual({
			cid: 'bafycid',
			rkey: RKEY,
			collection: RSVP_COLLECTION,
			time_us: TIME_US,
			eventUri: EVENT_URI,
			eventCid: 'bafyevent'
		});
		expect(body.metadata).not.toHaveProperty('rev');
	});

	it('accepts a bare string subject from older clients', () => {
		const body = bodyFor({ subject: EVENT_URI, status: 'going' });
		expect(body.eventSourceId).toBe(EVENT_URI);
		expect(body.metadata.eventCid).toBeUndefined();
	});

	it('uses the creator handle when the record supplies one', () => {
		expect(bodyFor({ ...MINIMAL, creator: { handle: 'alice.bsky.social' } }).userHandle).toBe(
			'alice.bsky.social'
		);
	});

	it('falls back to the DID as handle when the record supplies none', () => {
		expect(bodyFor(MINIMAL).userHandle).toBe(DID);
	});

	it('derives the timestamp from time_us when the record has no createdAt', () => {
		// contrail carries no commit wall-clock, so the fallback converts
		// microseconds rather than reading the jetstream commit's `time`.
		expect(bodyFor(MINIMAL).timestamp).toBe(new Date(TIME_US / 1000).toISOString());
	});

	it.each(['going', 'interested', 'notgoing'])('accepts the %s status', (status) => {
		expect(bodyFor({ ...MINIMAL, status }).status).toBe(status);
	});
});

describe('rsvpRequestFor — deletes', () => {
	it('deletes by sourceId query, tolerating 404', () => {
		const result = rsvpRequestFor({
			kind: 'deleted',
			uri: URI,
			did: DID,
			collection: RSVP_COLLECTION,
			rkey: RKEY
		});
		expect(result).toEqual({
			kind: 'request',
			request: {
				method: 'DELETE',
				path: '/api/integration/rsvps',
				query: { sourceId: URI, sourceType: 'bluesky' },
				tolerate: [404]
			}
		});
	});
});

describe('rsvpRequestFor — skips', () => {
	it('skips a record with no subject', () => {
		expect(skipReason({ status: 'going' })).toMatch(/no subject reference/);
	});

	it('skips a subject object with no uri', () => {
		expect(skipReason({ subject: { cid: 'bafy' }, status: 'going' })).toMatch(
			/subject object missing uri/
		);
	});

	it('skips a subject that is neither string nor object', () => {
		expect(skipReason({ subject: 42, status: 'going' })).toMatch(/invalid subject format/);
	});

	it('skips a subject uri that is not an at:// URI', () => {
		expect(skipReason({ subject: 'https://example.com/event', status: 'going' })).toMatch(
			/not in AT Protocol format/
		);
	});

	it('skips an at:// URI missing its collection and rkey', () => {
		expect(skipReason({ subject: 'at://did:plc:bob', status: 'going' })).toMatch(
			/invalid AT Protocol URI format/
		);
	});

	it('skips an unrecognized status rather than guessing', () => {
		expect(skipReason({ ...MINIMAL, status: 'community.lexicon.calendar.rsvp#maybe' })).toMatch(
			/invalid rsvp status: maybe/
		);
	});

	it('skips a record from another collection', () => {
		const result = rsvpRequestFor({ ...created(MINIMAL), collection: EVENT_COLLECTION });
		expect(result).toMatchObject({ kind: 'skip' });
	});
});

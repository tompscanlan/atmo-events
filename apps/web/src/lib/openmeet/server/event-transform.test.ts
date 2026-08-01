// Coverage for the event transform.
//
// WRITTEN, NOT PORTED. bsky-event-processor's event-processor.service.spec.ts
// looks like a suite worth porting and is not: it defines a local
// `MockEventProcessorService` that reimplements a DIFFERENT payload shape
// (externalId/title/startAt/eventType:'inperson') and asserts the mock does what
// the mock does. It never imports the real service. Neither does the RSVP spec.
// The only file that imports the real services (processor.service.spec.ts)
// exercises RabbitMQ lifecycle and health checks, never a transform.
//
// So the logic ported here shipped with ZERO test coverage and was proven only
// by ~440 days of production traffic. These cases pin the behaviour that
// traffic established, so the port is anchored to something checkable.
import { describe, it, expect } from 'vitest';
import {
	determineEventType,
	eventRequestFor,
	findVirtualMeetingUrl,
	mapEventStatus,
	processLocation
} from './event-transform';
import { EVENT_COLLECTION, RSVP_COLLECTION, type SinkRecordEvent } from './types';

const DID = 'did:plc:alice';
const RKEY = '3kabc';
const URI = `at://${DID}/${EVENT_COLLECTION}/${RKEY}`;

function created(record: Record<string, unknown>): SinkRecordEvent {
	return {
		kind: 'created',
		uri: URI,
		did: DID,
		collection: EVENT_COLLECTION,
		rkey: RKEY,
		cid: 'bafycid',
		record,
		time_us: 1_700_000_000_000_000
	};
}

/** A record with the minimum the transform demands: a name and a valid start. */
const MINIMAL = { name: 'Test Event', startsAt: '2026-10-20T18:00:00Z' };

function requestFor(record: Record<string, unknown>) {
	const result = eventRequestFor(created(record));
	if (result.kind !== 'request') throw new Error(`expected a request, got skip: ${result.reason}`);
	return result.request;
}

function bodyFor(record: Record<string, unknown>) {
	// The payload is arbitrary JSON and the assertions walk into it freely, so
	// `any` is the honest type here rather than a fictional interface.
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	return requestFor(record).body as Record<string, any>;
}

describe('processLocation', () => {
	it('classifies a geo location, carrying name and numeric altitude', () => {
		expect(processLocation({ latitude: 1.5, longitude: -2.5, name: 'Park', altitude: 30 })).toEqual(
			{
				type: 'geo',
				latitude: 1.5,
				longitude: -2.5,
				name: 'Park',
				altitude: 30
			}
		);
	});

	it('omits a non-numeric altitude rather than passing it through', () => {
		const result = processLocation({ latitude: 1, longitude: 2, altitude: 'high' });
		expect(result).toEqual({ type: 'geo', latitude: 1, longitude: 2 });
		expect(result).not.toHaveProperty('altitude');
	});

	it('classifies an address and drops empty parts', () => {
		expect(
			processLocation({ street: '1 Main St', locality: 'Louisville', country: 'US', region: '' })
		).toEqual({
			type: 'address',
			country: 'US',
			locality: 'Louisville',
			street: '1 Main St'
		});
	});

	it('classifies a foursquare place', () => {
		expect(processLocation({ fsq_place_id: 'fsq123', name: 'The Venue' })).toEqual({
			type: 'fsq',
			fsqPlaceId: 'fsq123',
			name: 'The Venue'
		});
	});

	it('classifies an h3 cell', () => {
		expect(processLocation({ value: '8a2a1072b59ffff' })).toEqual({
			type: 'h3',
			value: '8a2a1072b59ffff'
		});
	});

	it('classifies a uri location', () => {
		expect(processLocation({ uri: 'https://meet.example/abc', name: 'Video' })).toEqual({
			type: 'uri',
			uri: 'https://meet.example/abc',
			name: 'Video'
		});
	});

	it('prefers geo over address when a location carries both', () => {
		expect(processLocation({ latitude: 1, longitude: 2, street: '1 Main St' }).type).toBe('geo');
	});

	it('falls back to unknown for an unrecognized shape', () => {
		expect(processLocation({ something: 'else' })).toEqual({ type: 'unknown' });
	});
});

describe('findVirtualMeetingUrl', () => {
	it('prefers a URI whose name marks it as a meeting link', () => {
		expect(
			findVirtualMeetingUrl([
				{ uri: 'https://tickets.example', name: 'Tickets' },
				{ uri: 'https://meet.example', name: 'Online meeting link' }
			])
		).toBe('https://meet.example');
	});

	it('matches meeting names case-insensitively and as substrings', () => {
		expect(findVirtualMeetingUrl([{ uri: 'https://s.example', name: 'Our LIVESTREAM here' }])).toBe(
			'https://s.example'
		);
	});

	it('admits an unnamed URI before falling through to the exclude check', () => {
		expect(
			findVirtualMeetingUrl([
				{ uri: 'https://tickets.example', name: 'Tickets' },
				{ uri: 'https://bare.example' }
			])
		).toBe('https://bare.example');
	});

	it('skips excluded names and takes the first non-excluded one', () => {
		expect(
			findVirtualMeetingUrl([
				{ uri: 'https://a.example', name: 'Get tickets' },
				{ uri: 'https://b.example', name: 'Directions' },
				{ uri: 'https://c.example', name: 'Agenda' }
			])
		).toBe('https://c.example');
	});

	it('falls back to the first URI when every name is excluded', () => {
		expect(
			findVirtualMeetingUrl([
				{ uri: 'https://a.example', name: 'Tickets' },
				{ uri: 'https://b.example', name: 'Directions' }
			])
		).toBe('https://a.example');
	});

	it('returns null for an empty list', () => {
		expect(findVirtualMeetingUrl([])).toBeNull();
	});
});

describe('determineEventType', () => {
	it.each([
		['community.lexicon.calendar.event#virtual', 'online'],
		['community.lexicon.calendar.event#hybrid', 'hybrid'],
		['community.lexicon.calendar.event#inperson', 'in-person'],
		['something.unrecognized', 'in-person']
	])('maps %s to %s', (mode, expected) => {
		expect(determineEventType(mode)).toBe(expected);
	});

	it('defaults to in-person when mode is absent', () => {
		expect(determineEventType(undefined)).toBe('in-person');
	});
});

describe('mapEventStatus', () => {
	it.each([
		['community.lexicon.calendar.event#cancelled', 'cancelled'],
		['community.lexicon.calendar.event#planned', 'draft'],
		['community.lexicon.calendar.event#scheduled', 'published'],
		// Postponed and rescheduled collapse to published: OpenMeet has no
		// distinct state and the event is still real.
		['community.lexicon.calendar.event#postponed', 'published'],
		['community.lexicon.calendar.event#rescheduled', 'published'],
		['something.unrecognized', 'published']
	])('maps %s to %s', (status, expected) => {
		expect(mapEventStatus(status)).toBe(expected);
	});

	it('defaults to published when status is absent', () => {
		expect(mapEventStatus(undefined)).toBe('published');
	});
});

describe('eventRequestFor — creates', () => {
	it('POSTs to the events intake endpoint, tolerating a racing 409', () => {
		const request = requestFor(MINIMAL);
		expect(request.method).toBe('POST');
		expect(request.path).toBe('/api/integration/events');
		expect(request.tolerate).toEqual([409]);
	});

	it('builds the full payload, keyed on the at:// URI as source id', () => {
		const body = bodyFor({
			...MINIMAL,
			description: 'A description',
			endsAt: '2026-10-20T20:00:00Z',
			mode: 'community.lexicon.calendar.event#virtual',
			status: 'community.lexicon.calendar.event#cancelled'
		});
		expect(body).toMatchObject({
			name: 'Test Event',
			description: 'A description',
			startDate: '2026-10-20T18:00:00Z',
			endDate: '2026-10-20T20:00:00Z',
			type: 'online',
			status: 'cancelled',
			visibility: 'public',
			source: { id: URI, type: 'bluesky' }
		});
	});

	it('substitutes placeholder text for a missing description', () => {
		expect(bodyFor(MINIMAL).description).toBe('No description provided');
	});

	it('carries the raw record and identity metadata, but no commit rev', () => {
		const body = bodyFor(MINIMAL);
		expect(body.source.rawRecord).toEqual(MINIMAL);
		expect(body.source.metadata).toEqual({
			cid: 'bafycid',
			rkey: RKEY,
			collection: EVENT_COLLECTION,
			time_us: 1_700_000_000_000_000,
			did: DID
		});
		// contrail carries no commit rev; the API stores metadata opaquely and
		// reads nothing from it, so omitting the field is safe.
		expect(body.source.metadata).not.toHaveProperty('rev');
	});

	it('keeps a valid end date and nulls an unparseable one', () => {
		expect(bodyFor({ ...MINIMAL, endsAt: '2026-10-20T20:00:00Z' }).endDate).toBe(
			'2026-10-20T20:00:00Z'
		);
		expect(bodyFor({ ...MINIMAL, endsAt: 'not-a-date' }).endDate).toBeNull();
	});
});

describe('eventRequestFor — locations', () => {
	it('maps a geo location to lat/lon with the name as description', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ latitude: 38.25, longitude: -85.76, name: 'Central Park' }]
		});
		expect(body.location).toEqual({ lat: 38.25, lon: -85.76, description: 'Central Park' });
	});

	it('nulls the description for an unnamed geo location', () => {
		const body = bodyFor({ ...MINIMAL, locations: [{ latitude: 1, longitude: 2 }] });
		expect(body.location).toEqual({ lat: 1, lon: 2, description: null });
	});

	it('flattens an address into a single comma-joined description', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [
				{
					name: 'The Hall',
					street: '1 Main St',
					locality: 'Louisville',
					region: 'KY',
					postalCode: '40202',
					country: 'US'
				}
			]
		});
		expect(body.location).toEqual({
			description: 'The Hall, 1 Main St, Louisville, KY 40202, US'
		});
	});

	it('omits absent address parts without leaving stray separators', () => {
		const body = bodyFor({ ...MINIMAL, locations: [{ street: '1 Main St', country: 'US' }] });
		expect(body.location).toEqual({ description: '1 Main St, US' });
	});

	// A coordinate-bearing fsq place never reaches the fsq branch: the geo check
	// runs first and wins, so it lands as a normal geo location. This is why the
	// gap below is narrower than it first looks.
	it('treats an fsq place carrying coordinates as a geo location', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ fsq_place_id: 'fsq123', name: 'The Venue', latitude: 1, longitude: 2 }]
		});
		expect(body.location).toEqual({ lat: 1, lon: 2, description: 'The Venue' });
	});

	// PINS A GAP, NOT AN ENDORSEMENT. processLocation classifies coordinate-less
	// fsq and h3 locations, and then the payload builder has no branch for
	// either, so the event reaches OpenMeet with NO location at all — the place
	// id or cell survives only inside source.rawRecord. This is what production
	// has done for ~440 days. Changing it would silently alter how a class of
	// events renders, so it is pinned here and left for a deliberate follow-up.
	it('drops a coordinate-less fsq location entirely (known gap, matches production)', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ fsq_place_id: 'fsq123', name: 'The Venue' }]
		});
		expect(body.location).toBeUndefined();
		expect(body.source.rawRecord.locations).toBeDefined();
	});

	it('drops an h3 location entirely (known gap, matches production)', () => {
		const body = bodyFor({ ...MINIMAL, locations: [{ value: '8a2a1072b59ffff' }] });
		expect(body.location).toBeUndefined();
	});

	it('only reads the first location when several are present', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ latitude: 1, longitude: 2 }, { street: '1 Main St' }]
		});
		expect(body.location).toEqual({ lat: 1, lon: 2, description: null });
	});
});

describe('eventRequestFor — virtual urls', () => {
	it('takes the virtual url from a uri-typed location', () => {
		const body = bodyFor({ ...MINIMAL, locations: [{ uri: 'https://meet.example' }] });
		expect(body.location).toEqual({ url: 'https://meet.example' });
	});

	it('falls back to the uris array when no location supplies one', () => {
		const body = bodyFor({
			...MINIMAL,
			uris: [{ uri: 'https://meet.example', name: 'Online meeting link' }]
		});
		expect(body.location).toEqual({ url: 'https://meet.example' });
	});

	it('prefers a uri-typed location over the uris array', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ uri: 'https://from-location.example' }],
			uris: [{ uri: 'https://from-uris.example', name: 'Online meeting link' }]
		});
		expect(body.location).toEqual({ url: 'https://from-location.example' });
	});

	it('attaches the url alongside a physical location for a hybrid event', () => {
		const body = bodyFor({
			...MINIMAL,
			locations: [{ latitude: 1, longitude: 2, name: 'Hall' }],
			uris: [{ uri: 'https://meet.example', name: 'Live stream' }]
		});
		expect(body.location).toEqual({
			lat: 1,
			lon: 2,
			description: 'Hall',
			url: 'https://meet.example'
		});
	});
});

describe('eventRequestFor — deletes', () => {
	it('routes to the atproto delete endpoint, tolerating 404', () => {
		const result = eventRequestFor({
			kind: 'deleted',
			uri: URI,
			did: DID,
			collection: EVENT_COLLECTION,
			rkey: RKEY
		});
		expect(result).toEqual({
			kind: 'request',
			request: {
				method: 'DELETE',
				path: `/api/integration/events/atproto/${DID}/${EVENT_COLLECTION}/${RKEY}`,
				query: { sourceType: 'bluesky' },
				tolerate: [404]
			}
		});
	});
});

describe('eventRequestFor — skips', () => {
	function skipReason(record: Record<string, unknown>) {
		const result = eventRequestFor(created(record));
		if (result.kind !== 'skip') throw new Error('expected a skip');
		return result.reason;
	}

	it('skips a record with no name', () => {
		expect(skipReason({ startsAt: '2026-10-20T18:00:00Z' })).toMatch(/missing name/);
	});

	it('skips a record with no start date', () => {
		expect(skipReason({ name: 'Test Event' })).toMatch(/missing or invalid start date/);
	});

	it('skips a record whose start date will not parse', () => {
		expect(skipReason({ name: 'Test Event', startsAt: 'whenever' })).toMatch(
			/missing or invalid start date/
		);
	});

	it('skips a record from another collection', () => {
		const result = eventRequestFor({ ...created(MINIMAL), collection: RSVP_COLLECTION });
		expect(result).toMatchObject({ kind: 'skip' });
	});
});

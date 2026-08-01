// Event transform: a `community.lexicon.calendar.event` record -> the OpenMeet
// platform's existing `/api/integration/events` intake call.
//
// Ported from bsky-event-processor's `EventProcessorService`
// (src/processor/event-processor.service.ts @ 20d5c74). That service is the
// pipeline this sink replaces, and it has been feeding production for ~440
// days, so its semantics are PROVEN and this port preserves them verbatim —
// including the quirks called out in comments below. Behaviour changes belong
// in a follow-up with its own testing, not smuggled in under a port.
//
// What necessarily changed, and why:
//   - Input shape. The old service consumed a jetstream commit envelope
//     (`message.commit.record`, `.rev`, `.cid`, `.time`). contrail hands us a
//     flat `SinkRecordEvent`. Every field maps across except `rev`, which
//     contrail does not carry — see `metadata` below.
//   - No NestJS, no axios, no prom-client. This is a pure function returning a
//     request descriptor; the sink executes it.
import { EVENT_COLLECTION, type IntakeRequest, type SinkRecordEvent } from './types';

/** A transform either produces a call to make, or declines with a reason.
 *
 *  The old service logged a warning and returned early on malformed records.
 *  Modelling that as a value instead of a side effect keeps the transform pure
 *  while preserving the diagnostic — the sink logs the reason, and tests can
 *  assert on WHY a record was dropped rather than just that it was. */
export type TransformResult =
	| { kind: 'request'; request: IntakeRequest }
	| { kind: 'skip'; reason: string };

const skip = (reason: string): TransformResult => ({ kind: 'skip', reason });

/** Normalized shape of the lexicon's five location variants. Only geo, address
 *  and uri go on to influence the payload — see `buildLocation`. */
type ProcessedLocation = Record<string, unknown> & { type: string };

/** Classify one lexicon location object. Mirrors `processLocation` L249-316.
 *  Order matters: the checks are overlapping (an fsq place carries lat/lng
 *  too), and the original's precedence is what production has been emitting. */
export function processLocation(location: Record<string, unknown>): ProcessedLocation {
	if ('latitude' in location && 'longitude' in location) {
		const result: ProcessedLocation = {
			type: 'geo',
			latitude: location.latitude,
			longitude: location.longitude
		};
		if ('name' in location && location.name) result.name = location.name;
		// Altitude is only carried when actually numeric — a bare presence check
		// would propagate a null/string through to the payload.
		if ('altitude' in location && typeof location.altitude === 'number') {
			result.altitude = location.altitude;
		}
		return result;
	}

	if ('country' in location || 'street' in location) {
		const a = location as Record<string, unknown>;
		return {
			type: 'address',
			...(a.country ? { country: a.country } : {}),
			...(a.postalCode ? { postalCode: a.postalCode } : {}),
			...(a.region ? { region: a.region } : {}),
			...(a.locality ? { locality: a.locality } : {}),
			...(a.street ? { street: a.street } : {}),
			...(a.name ? { name: a.name } : {})
		};
	}

	if ('fsq_place_id' in location) {
		return {
			type: 'fsq',
			fsqPlaceId: location.fsq_place_id,
			...(location.latitude ? { latitude: location.latitude } : {}),
			...(location.longitude ? { longitude: location.longitude } : {}),
			...(location.name ? { name: location.name } : {})
		};
	}

	if ('value' in location && !('uri' in location)) {
		return {
			type: 'h3',
			value: location.value,
			...(location.name ? { name: location.name } : {})
		};
	}

	if ('uri' in location) {
		return {
			type: 'uri',
			uri: location.uri,
			...(location.name ? { name: location.name } : {})
		};
	}

	return { type: 'unknown' };
}

/** Names that mark a URI as a virtual meeting link. */
const VIRTUAL_MEETING_NAMES = [
	'online meeting link',
	'live stream',
	'livestream',
	'stream place',
	'video',
	'conference'
];

/** Names that mark a URI as definitely NOT a meeting link — ticketing,
 *  directions, and the event's own OpenMeet page. */
const EXCLUDE_NAMES = [
	'openmeet event',
	'event image',
	'directions',
	'tickets',
	'billets',
	'register',
	'rsvp',
	'purchase',
	'get tickets',
	'luma',
	'meetup'
];

/** Pick the virtual-meeting URL out of a record's `uris`. Mirrors
 *  `findVirtualMeetingUrl` L318-372.
 *
 *  Three passes, in the original's order: an explicit virtual-meeting name
 *  wins; failing that the first URI that is unnamed or not excluded; failing
 *  that the first URI at all. That last fallback means an event whose only URI
 *  is a ticket link still gets that link attached — deliberate in the original,
 *  preserved here. */
export function findVirtualMeetingUrl(uris: Array<{ uri: string; name?: string }>): string | null {
	for (const uriObj of uris) {
		if (uriObj.name) {
			const nameLower = uriObj.name.toLowerCase();
			if (VIRTUAL_MEETING_NAMES.some((p) => nameLower.includes(p))) return uriObj.uri;
		}
	}

	for (const uriObj of uris) {
		// An unnamed URI could be a meeting link, so it is admitted.
		if (!uriObj.name) return uriObj.uri;
		const nameLower = uriObj.name.toLowerCase();
		if (!EXCLUDE_NAMES.some((p) => nameLower.includes(p))) return uriObj.uri;
	}

	return uris[0]?.uri || null;
}

/** lexicon `mode` -> OpenMeet event type. Mirrors `determineEventType` L374-386. */
export function determineEventType(mode?: unknown): string {
	if (!mode || typeof mode !== 'string') return 'in-person';
	switch (mode) {
		case 'community.lexicon.calendar.event#virtual':
			return 'online';
		case 'community.lexicon.calendar.event#hybrid':
			return 'hybrid';
		case 'community.lexicon.calendar.event#inperson':
		default:
			return 'in-person';
	}
}

/** lexicon `status` -> OpenMeet event status. Mirrors `mapEventStatus` L388-404.
 *
 *  Note that postponed and rescheduled both collapse to `published`: OpenMeet
 *  has no distinct state for them and the event is still real and still shown.
 *  Only `planned` becomes a draft, and only `cancelled` is cancelled. */
export function mapEventStatus(status?: unknown): string {
	if (!status || typeof status !== 'string') return 'published';
	switch (status) {
		case 'community.lexicon.calendar.event#cancelled':
			return 'cancelled';
		case 'community.lexicon.calendar.event#postponed':
			return 'published';
		case 'community.lexicon.calendar.event#rescheduled':
			return 'published';
		case 'community.lexicon.calendar.event#planned':
			return 'draft';
		case 'community.lexicon.calendar.event#scheduled':
		default:
			return 'published';
	}
}

/** Validate an ISO-ish date string the way the original did: by round-tripping
 *  it through Date and letting an invalid value throw. Returns null when the
 *  input is absent or unparseable. */
function validDate(value: unknown): string | null {
	if (typeof value !== 'string' || !value) return null;
	try {
		new Date(value).toISOString();
		return value;
	} catch {
		return null;
	}
}

/** Build the payload's `location` object from the classified location and the
 *  virtual URL. Mirrors L176-219.
 *
 *  QUIRK, PRESERVED: only `geo`, `address` and `uri` are consumed here. An fsq
 *  or h3 location is classified above and then contributes NOTHING to the
 *  payload — the event lands with no location at all (the raw values still ride
 *  along in `source.rawRecord`). That is what production does today. It looks
 *  like an oversight and may well be one, but changing it here would silently
 *  alter how a class of events renders, so it stays and is pinned by a test. */
function buildLocation(
	locationData: ProcessedLocation | null,
	virtualUrlIn: string | null
): { location: Record<string, unknown> | null; virtualUrl: string | null } {
	let virtualUrl = virtualUrlIn;
	let location: Record<string, unknown> | null = null;

	if (locationData) {
		if (locationData.type === 'geo' && 'latitude' in locationData && 'longitude' in locationData) {
			location = {
				lat: locationData.latitude,
				lon: locationData.longitude,
				description: locationData.name || null
			};
		} else if (locationData.type === 'address') {
			// "name, street, locality, region postalCode, country" — empty parts
			// drop out so a sparse address doesn't produce stray commas.
			const addressParts = [
				locationData.name,
				locationData.street,
				locationData.locality,
				[locationData.region, locationData.postalCode].filter(Boolean).join(' '),
				locationData.country
			].filter(Boolean);
			location = { description: addressParts.join(', ') };
		} else if (locationData.type === 'uri' && !virtualUrl) {
			// A URI location only supplies the virtual URL, and only when the
			// `uris` array hasn't already produced one.
			if ('uri' in locationData) virtualUrl = locationData.uri as string;
		}
	}

	if (virtualUrl) {
		location = location ?? {};
		location.url = virtualUrl;
	}

	return { location, virtualUrl };
}

/** Transform one applied event record into the intake call that should follow.
 *
 *  Deletes route to the dedicated atproto endpoint, which addresses the event
 *  by did/collection/rkey — the only identity a contrail `deleted` event
 *  carries. */
export function eventRequestFor(e: SinkRecordEvent): TransformResult {
	if (e.collection !== EVENT_COLLECTION) return skip(`not an event collection: ${e.collection}`);

	if (e.kind === 'deleted') {
		return {
			kind: 'request',
			request: {
				method: 'DELETE',
				path: `/api/integration/events/atproto/${e.did}/${e.collection}/${e.rkey}`,
				query: { sourceType: 'bluesky' },
				// Already absent is the end state we wanted.
				tolerate: [404]
			}
		};
	}

	const record = e.record;
	if (!record) return skip(`missing record: ${e.did}`);

	const atUri = `at://${e.did}/${e.collection}/${e.rkey}`;

	const locations = Array.isArray(record.locations)
		? (record.locations as Array<Record<string, unknown>>)
		: [];
	const locationData = locations.length > 0 ? processLocation(locations[0]) : null;

	// Priority 1: a URI-typed entry in `locations`. Priority 2: the `uris` array.
	let virtualUrl: string | null = null;
	const uriLocation = locations.find((loc) => 'uri' in loc);
	if (uriLocation && typeof uriLocation.uri === 'string') virtualUrl = uriLocation.uri;
	if (!virtualUrl && Array.isArray(record.uris) && record.uris.length > 0) {
		virtualUrl = findVirtualMeetingUrl(record.uris as Array<{ uri: string; name?: string }>);
	}

	if (!record.name) return skip(`missing name: ${atUri}`);

	// A missing or unparseable start date is fatal — OpenMeet has nowhere to put
	// a dateless event. A bad END date is merely dropped.
	const startDate = validDate(record.startsAt);
	if (!startDate) return skip(`missing or invalid start date: ${atUri}`);
	const endDate = validDate(record.endsAt);

	const { location } = buildLocation(locationData, virtualUrl);

	const payload: Record<string, unknown> = {
		name: record.name,
		description: record.description || 'No description provided',
		startDate,
		endDate,
		type: determineEventType(record.mode),
		status: mapEventStatus(record.status),
		visibility: 'public',
		source: {
			id: atUri,
			type: 'bluesky',
			rawRecord: record,
			metadata: {
				cid: e.cid,
				rkey: e.rkey,
				collection: e.collection,
				time_us: e.time_us,
				// `rev` is deliberately absent: contrail's RecordEvent has no commit
				// rev to carry. Verified safe — the intake DTO marks source.metadata
				// optional and nothing in openmeet-api reads metadata.rev; it is
				// stored opaquely.
				did: e.did
			}
		}
	};

	if (location) payload.location = location;

	return {
		kind: 'request',
		request: {
			method: 'POST',
			path: '/api/integration/events',
			body: payload,
			// The intake path is idempotent by source id and updates in place, so a
			// duplicate create returns 2xx rather than 409. The original service
			// carried a defensive 409 branch anyway; kept for the racing case.
			tolerate: [409]
		}
	};
}

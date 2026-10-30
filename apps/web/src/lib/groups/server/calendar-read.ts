// A group's members-only events, read from its calendar space with the member's own access:
// the host gives a credential for the space only to the group's roles, so it decides who
// sees them. Nothing is kept between requests, and the index never learns of one.
import type { FlatEventRecord } from '#lib/contrail.js';
import { calendarSpaceUri, GROUP_EVENT_COLLECTION } from '../ids';
import { holdsCalendarGrant } from '../scopes';
import type { CallerSession } from './caller';
import { isSpaceAccessDenied } from './space-credential';
import { credentialSpaceReader, type GroupSpaceRecord } from './space-read';

/** As the event components take it: the record whole, its address beside it. Null with no
 *  start, which every page needs. */
export function flatSpaceEvent(groupDid: string, record: GroupSpaceRecord): FlatEventRecord | null {
	if (typeof record.value.startsAt !== 'string') return null;
	return {
		...(record.value as unknown as FlatEventRecord),
		cid: record.cid,
		did: groupDid,
		rkey: record.rkey,
		uri: record.uri
	};
}

/** Without its image: a page would build a public CDN URL from it, handing a third party the
 *  group's DID and the image's CID. */
function forDisplay(groupDid: string, record: GroupSpaceRecord): FlatEventRecord | null {
	const event = flatSpaceEvent(groupDid, record);
	if (!event) return null;
	delete event.media;
	return event;
}

/** Null when the caller may not read the space: no grant, or the host turns them away. Any
 *  other failure throws, so "could not read" never passes for "none". */
export async function readMembersOnlyEvents(
	caller: CallerSession,
	groupDid: string
): Promise<FlatEventRecord[] | null> {
	if (!holdsCalendarGrant(caller.scope, 'read', groupDid)) return null;
	let records: GroupSpaceRecord[];
	try {
		records = await credentialSpaceReader(caller).list({
			space: calendarSpaceUri(groupDid),
			repo: groupDid,
			collection: GROUP_EVENT_COLLECTION
		});
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
	return (
		records
			// The space also holds its access record, should the host ignore the filter.
			.filter((record) => record.collection === GROUP_EVENT_COLLECTION)
			.map((record) => forDisplay(groupDid, record))
			.filter((event): event is FlatEventRecord => event !== null)
	);
}

/** Null for an event that is not there and for a caller kept out alike, so the page cannot
 *  tell one from the other. */
export async function readMembersOnlyEvent(
	caller: CallerSession,
	groupDid: string,
	rkey: string
): Promise<FlatEventRecord | null> {
	if (!holdsCalendarGrant(caller.scope, 'read', groupDid)) return null;
	try {
		const found = await credentialSpaceReader(caller).get({
			space: calendarSpaceUri(groupDid),
			repo: groupDid,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
		return found ? forDisplay(groupDid, found) : null;
	} catch (e) {
		if (isSpaceAccessDenied(e)) return null;
		throw e;
	}
}

/** Not over yet, soonest first. */
export function upcoming(events: FlatEventRecord[], now = Date.now()): FlatEventRecord[] {
	return events
		.filter((event) => Date.parse(event.endsAt ?? event.startsAt) >= now)
		.sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
}

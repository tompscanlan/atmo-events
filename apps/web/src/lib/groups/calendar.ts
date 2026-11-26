// A group's members-only events: ordinary calendar events, kept in one calendar space the group
// owns at its group host, which only the group's roles may read. Its type is the one private
// events use, so the same scopes and calendar apps read it. Values only, so the pages can import
// them; apart from ./ids, which the contrail config imports, as it cannot resolve `#lib/`.
import { EVENT_COLLECTION, PRIVATE_CALENDAR_TYPE } from '#lib/private-events/ids.js';
import { spaceRecordUri } from '#lib/spaces/uri.js';
import { spaceUri } from './ids';

export const CALENDAR_SPACE_TYPE = PRIVATE_CALENDAR_TYPE;

/** One calendar space a group, keyed `self` as its other spaces are: who may read it is decided by
 *  role, so every members-only event shares it, where a private event has a space of its own for
 *  its own guest list. */
export function calendarSpaceUri(groupDid: string): string {
	return spaceUri(groupDid, CALENDAR_SPACE_TYPE);
}

/** The group's own record in its calendar space: the URI a member's RSVP names. */
export function membersOnlyEventUri(groupDid: string, rkey: string): string {
	return spaceRecordUri(calendarSpaceUri(groupDid), groupDid, EVENT_COLLECTION, rkey);
}

// A group's members-only events: ordinary calendar events, kept in one calendar space the group
// owns at its group host, which only the group's roles may read. Its type is the one private
// events use, so the same scopes and calendar apps read it. Values only, so the pages can import
// them; apart from ./ids, which the contrail config imports, as it cannot resolve `#lib/`.
import { EVENT_COLLECTION, PRIVATE_CALENDAR_TYPE } from '#lib/private-events/ids.js';
import { spaceRecordUri } from '#lib/spaces/uri.js';
import { spaceUri } from './ids';

export const CALENDAR_SPACE_TYPE = PRIVATE_CALENDAR_TYPE;

/** One calendar space a group: who may read it is decided by role, so every members-only event
 *  shares it, where a private event has a space of its own for its own guest list. Keyed `self`,
 *  as the group's other spaces are, when atmo makes it; another app that made the group a calendar
 *  first may have given it any key, and that one is used instead (./server/calendar-choice.ts). */
export function calendarSpaceUri(groupDid: string, skey?: string): string {
	return spaceUri(groupDid, CALENDAR_SPACE_TYPE, skey);
}

// A record key, as atproto allows one, and so a space key too.
const KEY = '[a-zA-Z0-9._:~-]{1,512}';

/** The key of `space` when it is one of the group's own calendar spaces; null for anything else. */
export function calendarSkeyOf(space: string, groupDid: string): string | null {
	const prefix = calendarSpaceUri(groupDid, '');
	if (!space.startsWith(prefix)) return null;
	const skey = space.slice(prefix.length);
	return new RegExp(`^${KEY}$`).test(skey) ? skey : null;
}

/** The group's own record in its calendar space: the URI a member's RSVP names. */
export function membersOnlyEventUri(
	groupDid: string,
	rkey: string,
	space = calendarSpaceUri(groupDid)
): string {
	return spaceRecordUri(space, groupDid, EVENT_COLLECTION, rkey);
}

/** The calendar space a members-only event's URI names, when it is the group's own event in one
 *  of the group's calendar spaces; null for anything else. */
export function eventCalendarSpace(groupDid: string, uri: string): string | null {
	const tail = `/${groupDid}/${EVENT_COLLECTION}/`;
	const at = uri.lastIndexOf(tail);
	if (at === -1 || !new RegExp(`^${KEY}$`).test(uri.slice(at + tail.length))) return null;
	const space = uri.slice(0, at);
	return calendarSkeyOf(space, groupDid) === null ? null : space;
}

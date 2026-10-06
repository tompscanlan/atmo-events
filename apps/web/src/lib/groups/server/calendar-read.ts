// The members-only slice of a group's events: the ones written into its
// calendar space instead of its public repo.
//
// Only a roster member may cause this read. The check runs before the reader is
// touched, so a viewer who may not see the slice costs the group's PDS nothing
// and the records never leave it on their behalf. A filter applied after the
// fetch would render the same page, but it would already have pulled the
// records out, and the next refactor could drop it. (Spec: FR-106.)
//
// The read goes through the group's own space reader, the one the roster read
// uses, on the group's session: the group authors its events, and a space lets
// an account read its own records with no member credential. Nothing here goes
// through the index, which cannot see a space, and nothing is kept between
// requests, so one member's read can never be served to anyone else.
// (Spec: FR-105.)
import { canSeeMembers } from '../access';
import type { CallerMembership, GroupEventRecord, GroupRow } from '../types';
import type { GroupSpaceReader, GroupSpaceRecord } from './about-read';
import { GROUP_EVENT_COLLECTION } from './event-writer';
import { groupSpaceUris } from './spaces';

/** A member's notice when the group's session is gone: nothing can read the
 *  space until an organizer links the group's account again. (Spec: FR-121.) */
export const MEMBERS_ONLY_UNLINKED =
	"Members-only events can't be shown until an organizer relinks the group.";

/** A member's notice when the space read failed for any other reason. */
export const MEMBERS_ONLY_UNREADABLE = "Members-only events couldn't be loaded right now.";

/** What a roster member gets. `notice` says why `events` is empty when the
 *  slice could not be read, and is null when it was read, empty or not. */
export interface MembersOnlySlice {
	events: GroupEventRecord[];
	notice: string | null;
}

/** The host's own error code for a space it never created, as the reader names
 *  it in what it throws. A group made before the calendar space existed has
 *  none, and that is an empty slice, not a failed read. */
const NO_SUCH_SPACE = /\bSpaceNotFound\b/;

/**
 * The calendar space's events for `membership`, or null for a caller off the
 * roster. Null means no read was made and there is nothing to say, so the page
 * is exactly what it was before this slice existed.
 *
 * A failed read never falls back to anything: a member gets the public slice
 * and a notice, and the error goes to the log.
 */
export async function readMembersOnlyEvents(
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	group: Pick<GroupRow, 'group_did'>
): Promise<MembersOnlySlice | null> {
	// The roster, never the group's visibility: a public group lets everyone see
	// it, and only its members see this slice.
	if (!canSeeMembers(membership)) return null;

	if (!reader) return { events: [], notice: MEMBERS_ONLY_UNLINKED };

	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	let records: GroupSpaceRecord[];
	try {
		records = await reader.list({
			space,
			repo: group.group_did,
			collection: GROUP_EVENT_COLLECTION
		});
	} catch (e) {
		if (e instanceof Error && NO_SUCH_SPACE.test(e.message)) return { events: [], notice: null };
		console.error(
			`[groups] ${group.group_did}: the calendar space could not be read; members-only events are left out:`,
			e
		);
		return { events: [], notice: MEMBERS_ONLY_UNREADABLE };
	}

	const events: GroupEventRecord[] = [];
	for (const record of records) {
		// The space also holds its access record. The host was asked for events
		// only, and each record is checked again in case it ignored the filter.
		if (record.collection !== GROUP_EVENT_COLLECTION) continue;
		// The URI stays the space form the reader built, since that is the
		// event's identity wherever it is cited. (Spec: FR-120.)
		events.push({
			uri: record.uri,
			cid: record.cid,
			rkey: record.rkey,
			value: record.value,
			space
		});
	}
	return { events, notice: null };
}

/** A record's own `createdAt` in milliseconds, or -Infinity when it has none
 *  that parses, so an undated record sorts last rather than first. */
function createdAtOf(event: GroupEventRecord): number {
	const at = event.value.createdAt;
	const ms = typeof at === 'string' ? Date.parse(at) : NaN;
	return Number.isNaN(ms) ? -Infinity : ms;
}

/**
 * Both slices as one list, newest first by each record's own `createdAt`, as
 * the index orders the public slice, with ties broken by URI so the order is
 * stable. The public records are passed through as they came, with no key
 * added, and two events that share an rkey stay apart by their URIs.
 */
export function unionGroupEvents(
	publicEvents: GroupEventRecord[],
	membersOnly: GroupEventRecord[]
): GroupEventRecord[] {
	return [...publicEvents, ...membersOnly].sort(
		(a, b) => createdAtOf(b) - createdAtOf(a) || (a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0)
	);
}

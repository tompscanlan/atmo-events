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
import { isRecordKey } from '@atcute/lexicons/syntax';
import type { FlatEventRecord } from '$lib/contrail';
import { canSeeMembers } from '../access';
import type { CallerMembership, GroupEventRecord, GroupRow } from '../types';
import { spaceRecordUri, type GroupSpaceReader, type GroupSpaceRecord } from './about-read';
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
		// No notice for a space the host never created, but a host that answered a
		// refused read the same way would leave a member silently seeing nothing,
		// so the log still says it happened.
		if (e instanceof Error && NO_SUCH_SPACE.test(e.message)) {
			console.warn(
				`[groups] ${group.group_did}: the host answered SpaceNotFound for the calendar space; the slice is shown empty, with no notice:`,
				e
			);
			return { events: [], notice: null };
		}
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
		// Images are wanted on every event. Leaving a members-only event's image
		// out is interim, until members-only images are served to members through
		// atmo's own route: the card would build a cdn.bsky.app URL from it, which
		// hands a third party the group's DID and the image's CID. Only what the
		// page reads loses it; the stored record keeps its image. (Spec: FR-119.)
		const value = { ...record.value };
		delete value.media;
		// The URI stays the space form the reader built, since that is the
		// event's identity wherever it is cited. (Spec: FR-120.)
		events.push({
			uri: record.uri,
			cid: record.cid,
			rkey: record.rkey,
			value,
			space
		});
	}
	return { events, notice: null };
}

/** What one members-only event's read comes to, for its page and its edit page.
 *
 *  - `hidden`: the caller is off the roster, and nothing was read.
 *  - `unlinked`: a member, but the group's session is gone, so nothing could be.
 *  - `absent`: the calendar space holds no event at that key, or the group has
 *    no calendar space at all.
 *  - `unreadable`: the read failed, and the error went to the log.
 *  - `found`: the event, whole, at its space-form URI, naming the space it was
 *    read from.
 *
 *  A page answers `hidden` and `absent` alike, so a caller off the roster
 *  cannot tell an event that exists from one that does not. */
export type MembersOnlyEventRead =
	| { status: 'hidden' }
	| { status: 'unlinked'; notice: string }
	| { status: 'absent' }
	| { status: 'unreadable'; notice: string }
	| { status: 'found'; event: GroupEventRecord & { space: string } };

/**
 * One members-only event by its key, read from the calendar space as the group,
 * for a roster member only.
 *
 * The roster check is the first thing it does, before the reader is touched, as
 * for the whole slice: a caller who may not see the event costs the group's PDS
 * nothing, and a check moved after the read could be dropped by the next
 * refactor. (Spec: FR-106, FR-117.)
 *
 * The record comes back exactly as stored. The edit page saves what it loads,
 * so a read that left a field out would delete it on the next save; a page that
 * must not show a field drops it from its own copy (`membersOnlyEventForDisplay`).
 * Nothing is kept between requests and nothing falls back to another source, so
 * one member's read can never be served to anyone else.
 */
export async function readMembersOnlyEvent(
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	group: Pick<GroupRow, 'group_did'>,
	rkey: string
): Promise<MembersOnlyEventRead> {
	if (!canSeeMembers(membership)) return { status: 'hidden' };

	if (!reader) return { status: 'unlinked', notice: MEMBERS_ONLY_UNLINKED };

	// A key no record can have names nothing, so the host is not asked.
	if (!isRecordKey(rkey)) return { status: 'absent' };

	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	let found: GroupSpaceRecord | null;
	try {
		found = await reader.get({
			space,
			repo: group.group_did,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
	} catch (e) {
		// A group made before the calendar space existed has no members-only
		// events, which is not a failure. The log still says it happened, as the
		// slice's does, naming the group and not its calendar space.
		if (e instanceof Error && NO_SUCH_SPACE.test(e.message)) {
			console.warn(
				`[groups] ${group.group_did}: the host answered SpaceNotFound for the calendar space; the event is absent:`,
				e
			);
			return { status: 'absent' };
		}
		console.error(
			`[groups] ${group.group_did}: a members-only event could not be read from the calendar space:`,
			e
		);
		return { status: 'unreadable', notice: MEMBERS_ONLY_UNREADABLE };
	}

	// The host was asked for one event by its key. A record it hands back under
	// any other collection or key is not that event.
	if (!found || found.collection !== GROUP_EVENT_COLLECTION || found.rkey !== rkey) {
		return { status: 'absent' };
	}

	// The URI is the space form, built as the slice builds it, so the event's
	// page and the events tab name it the same way. That form is the event's
	// identity wherever it is cited. (Spec: FR-120.)
	return {
		status: 'found',
		event: {
			uri: spaceRecordUri(space, group.group_did, GROUP_EVENT_COLLECTION, rkey),
			cid: found.cid,
			rkey,
			value: found.value,
			space
		}
	};
}

/**
 * A copy of a members-only event for a page to show, without its image. The
 * page would build a cdn.bsky.app URL from the image, which hands a third party
 * the group's DID and the image's CID. That is interim, until members get the
 * image through atmo's own route. (Spec: FR-119.)
 *
 * The copy is shallow: only its top-level image key is dropped, so the event it
 * is given keeps its image, and every nested value is shared between the two.
 * Only the event's page calls this: the edit page saves what it loads, so
 * dropping the image there would delete it.
 */
export function membersOnlyEventForDisplay(event: GroupEventRecord): GroupEventRecord {
	const value = { ...event.value };
	delete value.media;
	return { ...event, value };
}

/**
 * A members-only event as the edit page hands it to the editor: the record
 * whole, image included, with the event's cid, the group's DID, its key and
 * its space-form URI beside it, as the index's events carry them. Null for a
 * record with no start, which the editor cannot open.
 *
 * The editor saves what it loads: it spreads this into the record it writes
 * and deletes only what the index adds to an event (the cid, DID, key, URI and
 * RSVP counts). So nothing may be left out, or the next save deletes it, and
 * nothing may be added. In particular the calendar space is not set here: a
 * key naming the container would be written into the event, and placement is
 * the container itself, never a field. (Spec: FR-104, FR-119.)
 */
export function membersOnlyEventForEditing(
	event: GroupEventRecord,
	group: Pick<GroupRow, 'group_did'>
): FlatEventRecord | null {
	if (typeof event.value.startsAt !== 'string') return null;
	return {
		...(event.value as unknown as FlatEventRecord),
		cid: event.cid,
		did: group.group_did,
		rkey: event.rkey,
		uri: event.uri
	};
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

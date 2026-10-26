// The members-only slice of a group's events, read from its calendar space with the
// member's own access. The roster check comes before the reader is touched, so a viewer
// who may not see the slice costs the host nothing, and nothing is kept between requests.
import { isRecordKey } from '@atcute/lexicons/syntax';
import type { FlatEventRecord } from '$lib/contrail';
import { canSeeMembers } from '../access';
import { GROUP_EVENT_COLLECTION, groupSpaceUris, membersOnlyEventUri } from '../ids';
import type { CallerMembership, GroupEventRecord, GroupRow } from '../types';
import { isSpaceNotFound, type GroupSpaceReader } from './about-read';

/** For a member whose sign-in reads no spaces. */
export const MEMBERS_ONLY_NO_ACCESS =
	"Members-only events can't be shown: your sign-in doesn't let this site read the group's spaces.";

export const MEMBERS_ONLY_UNREADABLE = "Members-only events couldn't be loaded right now.";

/** `notice` says why `events` is empty when the slice could not be read. */
export interface MembersOnlySlice {
	events: GroupEventRecord[];
	notice: string | null;
}

type CalendarRead<T> =
	| { status: 'hidden' }
	| { status: 'no-access' }
	| { status: 'no-space' }
	| { status: 'unreadable' }
	| { status: 'read'; space: string; value: T };

async function readCalendarSpace<T>(
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	group: Pick<GroupRow, 'group_did'>,
	read: (reader: GroupSpaceReader, space: string) => Promise<T>
): Promise<CalendarRead<T>> {
	// The roster, never the group's visibility: a public group still keeps these to members.
	if (!canSeeMembers(membership)) return { status: 'hidden' };
	if (!reader) return { status: 'no-access' };
	const space = groupSpaceUris(group.group_did).calendarSpaceUri;
	try {
		return { status: 'read', space, value: await read(reader, space) };
	} catch (e) {
		if (isSpaceNotFound(e)) {
			console.warn(`[groups] ${group.group_did}: the calendar space is not there:`, e);
			return { status: 'no-space' };
		}
		console.error(`[groups] ${group.group_did}: the calendar space could not be read:`, e);
		return { status: 'unreadable' };
	}
}

/** Null for a caller off the roster: no read was made, and the page shows the public slice
 *  alone. A failed read never falls back to anything. Records come back whole, image included. */
export async function readMembersOnlyEvents(
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	group: Pick<GroupRow, 'group_did'>
): Promise<MembersOnlySlice | null> {
	const read = await readCalendarSpace(membership, reader, group, (r, space) =>
		r.list({ space, repo: group.group_did, collection: GROUP_EVENT_COLLECTION })
	);
	if (read.status === 'hidden') return null;
	if (read.status === 'no-access') return { events: [], notice: MEMBERS_ONLY_NO_ACCESS };
	if (read.status === 'no-space') return { events: [], notice: null };
	if (read.status === 'unreadable') return { events: [], notice: MEMBERS_ONLY_UNREADABLE };
	return {
		events: read.value
			// The space also holds its access record, should the host ignore the filter.
			.filter((record) => record.collection === GROUP_EVENT_COLLECTION)
			.map((record) => ({
				uri: record.uri,
				cid: record.cid,
				rkey: record.rkey,
				value: record.value,
				space: read.space
			})),
		notice: null
	};
}

/** A page answers `hidden` and `absent` alike, so a caller off the roster cannot tell an
 *  event that exists from one that does not. */
export type MembersOnlyEventRead =
	| { status: 'hidden' }
	| { status: 'no-access'; notice: string }
	| { status: 'absent' }
	| { status: 'unreadable'; notice: string }
	| { status: 'found'; event: GroupEventRecord & { space: string } };

/** Exactly as stored: the edit page saves what it loads, so a field left out would be deleted. */
export async function readMembersOnlyEvent(
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	group: Pick<GroupRow, 'group_did'>,
	rkey: string
): Promise<MembersOnlyEventRead> {
	const read = await readCalendarSpace(membership, reader, group, (r, space) =>
		isRecordKey(rkey)
			? r.get({ space, repo: group.group_did, collection: GROUP_EVENT_COLLECTION, rkey })
			: Promise.resolve(null)
	);
	if (read.status === 'hidden') return { status: 'hidden' };
	if (read.status === 'no-access') return { status: 'no-access', notice: MEMBERS_ONLY_NO_ACCESS };
	if (read.status === 'no-space') return { status: 'absent' };
	if (read.status === 'unreadable') {
		return { status: 'unreadable', notice: MEMBERS_ONLY_UNREADABLE };
	}
	const found = read.value;
	if (!found || found.collection !== GROUP_EVENT_COLLECTION || found.rkey !== rkey) {
		return { status: 'absent' };
	}
	return {
		status: 'found',
		event: {
			uri: membersOnlyEventUri(group.group_did, rkey),
			cid: found.cid,
			rkey,
			value: found.value,
			space: read.space
		}
	};
}

/** Without its image: a page would build a public CDN URL from it, handing a third party the
 *  group's DID and the image's CID. Shallow; the event given keeps its image. */
export function membersOnlyEventForDisplay(event: GroupEventRecord): GroupEventRecord {
	const value = { ...event.value };
	delete value.media;
	return { ...event, value };
}

/** As the editor takes it: the record whole, with the index's fields beside it and no key
 *  naming the space, which the editor would write into the record. Null with no start. */
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

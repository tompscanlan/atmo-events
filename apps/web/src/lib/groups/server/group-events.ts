// A group's events as one viewer may see them, for the group page and its events tab.
import type { GroupSchedule } from '../event-schedule';
import { scheduleGroupEvents } from '../event-schedule';
import type { CallerMembership, GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { membersOnlyEventForDisplay, readMembersOnlyEvents } from './calendar-read';
import { listGroupEvents } from './events-index';

export interface GroupEvents extends GroupSchedule {
	/** Why a member sees no members-only events, when they could not be read. */
	membersOnlyNotice: string | null;
}

/** The public events from the index, for anyone; beside them, for a roster member, the
 *  members-only ones without their images, as on their own page. A failed index read shows none. */
export async function readGroupEvents(
	db: D1Database,
	group: GroupRow,
	membership: CallerMembership,
	reader: GroupSpaceReader | null,
	asOf = new Date().toISOString()
): Promise<GroupEvents> {
	const [events, membersOnly] = await Promise.all([
		listGroupEvents(db, group).catch((e) => {
			console.error(`[groups] listGroupEvents failed for ${group.group_did}:`, e);
			return [];
		}),
		readMembersOnlyEvents(membership, reader, group)
	]);
	return {
		...scheduleGroupEvents(
			[...events, ...(membersOnly?.events.map(membersOnlyEventForDisplay) ?? [])],
			asOf
		),
		membersOnlyNotice: membersOnly?.notice ?? null
	};
}

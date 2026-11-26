import { error } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import {
	GROUP_NOT_FOUND,
	groupView,
	NO_POSTING,
	requireGroupWriter
} from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { calendarSpaceState } from '#lib/groups/server/group-events.js';

/** Why members-only is not offered, by the state of the group's calendar space. */
const MEMBERS_ONLY_UNAVAILABLE = {
	missing: "Members-only events aren't turned on for this group. Turn them on from its page.",
	readable: "This group's calendar can be read by more than its members.",
	unusable: "This group's calendar wasn't set up for atmo to post members-only events to.",
	unchecked: "Whether members-only events are on couldn't be checked just now. Reload to try again."
} as const;

/** A link that was approved before the calendar space was made. */
const APPROVE_ONCE_MORE = "Approve your link once more, from the group's page, to post these.";

export async function load({ params, locals, setHeaders }) {
	requireGroupsEnabled();
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals.did);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	const { can } = group.linked;
	if (!can.post && !can.membersOnly) error(403, NO_POSTING);

	let membersOnlyUnavailable: string | null = null;
	if (can.membersOnly || can.turnOnMembersOnly) {
		// Asked here, since the editor reports any failed save in the same words.
		const state = await calendarSpaceState(await requireGroupWriter(group.did, locals.did)).catch(
			() => 'unchecked' as const
		);
		if (state !== 'ready') membersOnlyUnavailable = MEMBERS_ONLY_UNAVAILABLE[state];
		else if (!can.membersOnly) membersOnlyUnavailable = APPROVE_ONCE_MORE;
	} else {
		membersOnlyUnavailable = "Your role in this group doesn't let you post members-only events.";
	}
	return {
		pageTitle: `New event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		rkey: tidNow(),
		/** Public posting, for a link whose scope allows it. */
		postsPublic: can.post,
		/** Why members-only is not offered; null when it is. */
		membersOnlyUnavailable
	};
}

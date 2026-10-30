import { error } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import { GROUP_NOT_FOUND, groupView, requireGroupWriter } from '#lib/groups/server/context.js';
import { calendarSpaceState } from '#lib/groups/server/group-events.js';

const MEMBERS_ONLY_UNAVAILABLE = {
	missing: 'This group has no calendar space for members-only events.',
	readable: "This group's calendar space can be read by more than its members.",
	unchecked: "The group's calendar space could not be checked just now. Reload to try again."
} as const;

export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	// Asked here, since the editor reports any failed save in the same words.
	const calendar = await calendarSpaceState(await requireGroupWriter(group.did, locals.did));
	return {
		pageTitle: `New event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		rkey: tidNow(),
		/** Why members-only is not offered; null when it is. */
		membersOnlyUnavailable: calendar === 'ready' ? null : MEMBERS_ONLY_UNAVAILABLE[calendar]
	};
}

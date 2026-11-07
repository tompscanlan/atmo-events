import { error } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import { GROUP_NOT_FOUND, groupView, requireGroupWriter } from '#lib/groups/server/context.js';
import { calendarSpaceState } from '#lib/groups/server/group-events.js';
import { forgetAsked, groupAccess } from '#lib/groups/permissions-asked.js';

const MEMBERS_ONLY_UNAVAILABLE = {
	missing: 'This group has no calendar space for members-only events.',
	readable: "This group's calendar space can be read by more than its members.",
	unchecked: "The group's calendar space could not be checked just now. Reload to try again."
} as const;

/** The poster writes as the group, but sees members-only events only with their own access. */
const MEMBERS_ONLY_UNSEEN = {
	ask: "You won't see it yourself until you allow atmo to read your groups, on the group's page.",
	refused: "You won't see it yourself: your server did not give atmo group permissions."
} as const;

export async function load({ params, locals, cookies, setHeaders }) {
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals);
	if (group.holdsAccess) forgetAsked(cookies);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	// Asked here, since the editor reports any failed save in the same words.
	const calendar = await calendarSpaceState(await requireGroupWriter(group.did, locals.did));
	const access = groupAccess(group.askAccess, cookies, locals.did);
	return {
		pageTitle: `New event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		rkey: tidNow(),
		/** Why members-only is not offered; null when it is. */
		membersOnlyUnavailable: calendar === 'ready' ? null : MEMBERS_ONLY_UNAVAILABLE[calendar],
		/** Why the poster will not see a members-only event they post; null when they will. */
		membersOnlyUnseen: access ? MEMBERS_ONLY_UNSEEN[access] : null
	};
}

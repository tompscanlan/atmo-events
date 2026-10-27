import { can } from '$lib/groups/permissions';
import { gateCaller } from '$lib/groups/server/caller';
import { listGroupEvents } from '$lib/groups/server/events-index';
import { groupHeader, groupRouteContext } from '$lib/groups/server/route-context';
import { publicGroup } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

/** The group's public events, read from the index like any other actor's, so the
 *  page renders for a visitor who is not signed in. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership, reader, signInOnly } = await groupRouteContext(
		db,
		params.actor,
		await gateCaller(locals.did, locals.session),
		{ signInNotice: true }
	);
	if (signInOnly && membership.signIn) {
		return { groupDid: group.group_did, signInOnly: true as const };
	}

	const [header, events] = await Promise.all([
		groupHeader(db, group, reader),
		listGroupEvents(db, group).catch((e) => {
			console.error(`[groups] listGroupEvents failed for ${group.group_did}:`, e);
			return [];
		})
	]);

	return {
		group: publicGroup(group),
		...header,
		events,
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT'),
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};

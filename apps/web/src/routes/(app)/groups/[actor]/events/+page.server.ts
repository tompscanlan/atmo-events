import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { listGroupEvents } from '$lib/groups/server/events-index';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** The group's public events. The records live in the group DID's own repo,
 *  where anyone can read and index them, and this page reads them from the
 *  app's index like any other actor's events. So the page renders for a visitor
 *  who is not signed in, and one event is one row in one database however it
 *  was discovered. A failed index read gives an empty list rather than a 500:
 *  the group itself is still worth showing.
 *
 *  The group's name comes from its profile record here too. The title and the
 *  back-link show the name, so this page does the same about read as the group
 *  page rather than using the cache column, and every tab shows the same name.
 *  An absent profile falls back to the row; a failed read fails the page. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	const reader = await groupSpaceReader(platform!.env, db, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	const events = await listGroupEvents(db, group).catch((e) => {
		console.error(`[groups] listGroupEvents failed for ${group.group_did}:`, e);
		return [];
	});

	return {
		group,
		membership,
		groupName: about.profile?.name ?? group.name,
		events,
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT'),
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};

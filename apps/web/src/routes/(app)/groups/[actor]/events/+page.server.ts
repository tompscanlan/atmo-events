import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { listGroupEvents } from '$lib/groups/server/events-read';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** The group's PUBLIC event slice, read straight from the group DID's repo with
 *  no credential — so this page renders for a visitor who has never logged in.
 *  A network failure at the PDS degrades to an empty list rather than a 500:
 *  the group itself still has a page worth showing. (Registering the group DID
 *  with contrail so this comes from the index instead is T018a.)
 *
 *  THE GROUP'S NAME IS A RECORD, even here. The title and the back-link are the
 *  group's name, so this page pays the same about read the group page does
 *  rather than printing the cache column — one name for one group, whichever
 *  tab you are on (FR-010). An ABSENT profile falls back to the row; a FAILED
 *  read fails the page. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(db, params.actor, locals.did);

	const reader = await groupSpaceReader(platform!.env, db, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	const events = await listGroupEvents(group).catch((e) => {
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

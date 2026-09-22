import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { listGroupEvents } from '$lib/groups/server/events-index';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** The group's PUBLIC event slice. The records live in the group DID's own
 *  repo, where they are anonymously readable and indexable, and this reads them
 *  back out of the app's index like any other actor's events — so the page
 *  renders for a visitor who has never logged in, and one event is one row in
 *  one database however it was discovered. An index read that fails degrades to
 *  an empty list rather than a 500: the group itself still has a page worth
 *  showing.
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

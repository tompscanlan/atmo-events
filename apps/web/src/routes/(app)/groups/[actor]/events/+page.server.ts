import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { listGroupEvents } from '$lib/groups/server/events-index';
import { knownHandles } from '$lib/groups/server/handles';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** The group's public events, read from the app's index like any other
 *  actor's, so the page renders for a visitor who is not signed in. A failed
 *  index read gives an empty list rather than a 500. The name comes from the
 *  profile record, as on the group page. */
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
		/** The handle Contrail knows for the group, or null. Display only. */
		handle: (await knownHandles(db, [group.group_did])).get(group.group_did) ?? null,
		events,
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT'),
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};

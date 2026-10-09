import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { readMembersOnlyEvents, unionGroupEvents } from '$lib/groups/server/calendar-read';
import { listGroupEvents } from '$lib/groups/server/events-index';
import { knownHandles } from '$lib/groups/server/handles';
import { groupRouteContext } from '$lib/groups/server/route-context';
import type { PageServerLoad } from './$types';

/** The group's events, in two slices. The public slice is read from the app's
 *  index like any other actor's, so the page renders for a visitor who is not
 *  signed in, and a failed index read gives an empty list rather than a 500.
 *  The members-only slice is read from the group's calendar space, and only
 *  for a roster member: anyone else causes no read of it, and gets back exactly
 *  what the page returned before that slice existed. The name comes from the
 *  profile record, as on the group page. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	const reader = await groupSpaceReader(platform!.env, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	const [events, membersOnly] = await Promise.all([
		listGroupEvents(db, group).catch((e) => {
			console.error(`[groups] listGroupEvents failed for ${group.group_did}:`, e);
			return [];
		}),
		// Null for a caller off the roster, who then gets the public slice untouched.
		readMembersOnlyEvents(membership, reader, group)
	]);

	return {
		group,
		membership,
		groupName: about.profile?.name ?? group.name,
		/** The handle Contrail knows for the group, or null. Display only. */
		handle: (await knownHandles(db, [group.group_did])).get(group.group_did) ?? null,
		events: membersOnly ? unionGroupEvents(events, membersOnly.events) : events,
		/** Why a member sees no members-only events, when they could not be read.
		 *  Only a roster member's data can carry it. */
		...(membersOnly?.notice ? { membersOnlyNotice: membersOnly.notice } : {}),
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT'),
		canManageEvents: can(membership.permissions, 'MANAGE_EVENTS')
	};
};

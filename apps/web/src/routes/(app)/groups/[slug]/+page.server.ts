import { error } from '@sveltejs/kit';
import { canSeeGroup, canSeeMembers } from '$lib/groups/access';
import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import {
	countActiveMembers,
	getCallerMembership,
	getGroupBySlug,
	listJoinRequests
} from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, params.slug);
	if (!group) error(404, 'Group not found');

	const membership = await getCallerMembership(db, group.id, locals.did);
	// A private group does not reveal that its slug exists.
	if (!canSeeGroup(group, membership)) error(404, 'Group not found');

	const canManageMembers = can(membership.permissions, 'MANAGE_MEMBERS');

	// THE GROUP'S PUBLIC FACE COMES FROM RECORDS, with the row as fallback.
	//
	// Not "records or nothing": a group provisioned before the profile writer
	// existed has an empty about space, and a page that 500'd or rendered blank
	// for it would be worse than one that renders the cache. So the reader's
	// absence and an empty space are both normal, and the fallback is the
	// columns the record would have overwritten anyway. (Spec: FR-004, FR-010.)
	const reader = await groupSpaceReader(platform!.env, db, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	return {
		group,
		membership,
		/** Where the rendered name/description/location actually came from, so
		 *  the page can say so rather than leaving it ambiguous — and so SC-002
		 *  is observable in a browser rather than only in a test. */
		about: {
			source: about.profile ? ('records' as const) : ('cache' as const),
			name: about.profile?.name ?? group.name,
			description: about.profile?.description ?? group.description,
			locationName: about.profile?.locationName ?? group.location_name,
			rules: about.rules.map((rule) => ({ text: rule.text, uri: rule.uri }))
		},
		memberCount: await countActiveMembers(db, group.id),
		// Only a MANAGE_MEMBERS holder is shown the queue; everyone else gets [].
		pendingRequests: canManageMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		canManageGroup: can(membership.permissions, 'MANAGE_GROUP'),
		canManageMembers,
		canSeeMembers: canSeeMembers(membership),
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT')
	};
};

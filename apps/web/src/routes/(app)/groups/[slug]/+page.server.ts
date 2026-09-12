import { error } from '@sveltejs/kit';
import { canSeeGroup, canSeeMembers } from '$lib/groups/access';
import { can } from '$lib/groups/permissions';
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

	return {
		group,
		membership,
		memberCount: await countActiveMembers(db, group.id),
		// Only a MANAGE_MEMBERS holder is shown the queue; everyone else gets [].
		pendingRequests: canManageMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		canManageGroup: can(membership.permissions, 'MANAGE_GROUP'),
		canManageMembers,
		canSeeMembers: canSeeMembers(membership),
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT')
	};
};

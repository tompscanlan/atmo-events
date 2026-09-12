import { error } from '@sveltejs/kit';
import { canSeeGroup, canSeeMembers } from '$lib/groups/access';
import { ASSIGNABLE_ROLES, V1_INERT_PERMISSIONS, can } from '$lib/groups/permissions';
import {
	getCallerMembership,
	getGroupBySlug,
	listJoinRequests,
	listMembers,
	rolePermissions
} from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** The roster is APP data — no protocol record carries it — so SEE_MEMBERS is a
 *  real gate here, and an anonymous visitor never passes it. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, params.slug);
	if (!group) error(404, 'Group not found');

	const membership = await getCallerMembership(db, group.id, locals.did);
	if (!canSeeGroup(group, membership)) error(404, 'Group not found');
	if (!canSeeMembers(membership)) {
		error(403, locals.did ? 'SEE_MEMBERS is required in this group' : 'Sign in to see members');
	}

	const canManageMembers = can(membership.permissions, 'MANAGE_MEMBERS');

	return {
		group,
		membership,
		members: await listMembers(db, group.id),
		pendingRequests: canManageMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		// The stored bundle per role, shown so an admin can see what a role grants
		// before assigning it — including the names v1 does not act on.
		rolePermissions: await rolePermissions(db, group.id),
		inertPermissions: V1_INERT_PERMISSIONS,
		assignableRoles: ASSIGNABLE_ROLES,
		canManageMembers
	};
};

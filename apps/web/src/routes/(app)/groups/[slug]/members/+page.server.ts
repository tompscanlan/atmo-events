import { error } from '@sveltejs/kit';
import { canSeeGroup, canSeeMembers } from '$lib/groups/access';
import { ASSIGNABLE_ROLES, can } from '$lib/groups/permissions';
import {
	getCallerMembership,
	getGroupBySlug,
	listJoinRequests,
	listMembers,
	rolePermissions
} from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** The roster is APP data — no protocol record carries it — and it is
 *  members-only at every visibility (FR-016b). The gate is membership, not a
 *  permission: read access is not something a group grants (FR-005d). */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const group = await getGroupBySlug(db, params.slug);
	if (!group) error(404, 'Group not found');

	const membership = await getCallerMembership(db, group.id, locals.did);
	if (!canSeeGroup(group, membership)) error(404, 'Group not found');
	if (!canSeeMembers(membership)) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	// Three grants, three controls: a greeter who may admit cannot eject or
	// promote, which is the whole point of splitting MANAGE_MEMBERS (FR-005b).
	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	return {
		group,
		membership,
		members: await listMembers(db, group.id),
		pendingRequests: canAdmitMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		// The stored bundle per role, shown so an admin can see what a role
		// grants before assigning it. Every name in it is enforced now — the ten
		// stored-but-inert ones are gone (FR-005a).
		rolePermissions: await rolePermissions(db, group.id),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		canEjectMembers: can(membership.permissions, 'EJECT_MEMBERS'),
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

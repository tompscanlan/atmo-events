import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { ASSIGNABLE_ROLES, can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import {
	NO_MEMBER_RECORDS,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	rosterFromRecords,
	rosterFromRows
} from '$lib/groups/server/members-read';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { listJoinRequests, listMembers, rolePermissions } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** The roster is records with a D1 cache behind it: a `membership` record in
 *  the group's members space is what grants a member their roles, and the
 *  `memberships` rows are a copy of it. So this page reads the records through
 *  the group's own session, and falls back to the rows only when there are no
 *  records to read (the space holds none, or this deployment holds no
 *  credential for the group).
 *
 *  The gate uses the same source. When the records exist they decide: a DID
 *  with no membership record cannot see the roster, even if a stale row says
 *  otherwise. It is a membership test either way, not a permission (read
 *  access is not something a group grants), and it is members-only at every
 *  visibility.
 *
 *  Before that, `groupRouteContext` decides whether the caller may see the
 *  group at all, from `groups.visibility` (an app-local column no record owns)
 *  and `membership.onRoster`, which comes from the membership record whenever
 *  the records can answer. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	const reader = await groupSpaceReader(platform!.env, db, group);
	// One reader, two reads: the roster, and the group's name for the back-link
	// (the name comes from the profile record, as on the other group pages).
	const members = reader ? await readGroupMembers(reader, group) : NO_MEMBER_RECORDS;
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
	const fromRecords = hasMemberRecords(members);

	if (fromRecords ? !hasRecordedAccess(members, locals.did) : !canSeeMembers(membership)) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	// Three grants, three controls: a greeter who may admit cannot eject or
	// promote.
	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	return {
		group,
		membership,
		groupName: about.profile?.name ?? group.name,
		members: fromRecords
			? rosterFromRecords(members)
			: rosterFromRows(await listMembers(db, group.id)),
		/** Which source the list above came from, so "the records are empty" is
		 *  never shown as "the group has no members". */
		rosterSource: fromRecords ? ('records' as const) : ('cache' as const),
		pendingRequests: canAdmitMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		// The stored bundle per role, shown so an admin can see what a role
		// grants before assigning it. Every name in it is enforced.
		rolePermissions: await rolePermissions(db, group.id),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		canEjectMembers: can(membership.permissions, 'EJECT_MEMBERS'),
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

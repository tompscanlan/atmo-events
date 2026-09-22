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

/** The roster is RECORDS with a D1 cache behind it, which is the direction T014
 *  reversed: a `membership` record in the group's members space is what grants a
 *  member their roles, and the `memberships` rows are a projection of it. So
 *  this page reads the records through the group's own session (FR-007a) and
 *  falls back to the rows only when the space holds none — a group provisioned
 *  before those records existed, or a deployment holding no credential for it.
 *
 *  THE GATE FOLLOWS THE SAME SOURCE. When the records exist they decide: a DID
 *  with no membership record has no access to the roster even if a stale row
 *  says otherwise (FR-006). It stays a membership test either way, not a
 *  permission — read access is not something a group grants (FR-005d) — and it
 *  is members-only at every visibility (FR-016b).
 *
 *  `groupRouteContext` still asks the D1 membership for the PAGE gate, because
 *  what it gates on is `groups.visibility`, which is app-local cache no record
 *  owns (`data-model.md` Tier 3). Moving the caller's ROLE AND PERMISSION
 *  resolution onto records is T016 (`om-i92w3`); this page moves the roster and
 *  its own gate. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	const reader = await groupSpaceReader(platform!.env, db, group);
	// One reader, two reads: the roster this page is for, and the group's name
	// for its back-link — which is a record like every other name (FR-010).
	const members = reader ? await readGroupMembers(reader, group) : NO_MEMBER_RECORDS;
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
	const fromRecords = hasMemberRecords(members);

	if (fromRecords ? !hasRecordedAccess(members, locals.did) : !canSeeMembers(membership)) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	// Three grants, three controls: a greeter who may admit cannot eject or
	// promote, which is the whole point of splitting MANAGE_MEMBERS (FR-005b).
	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	return {
		group,
		membership,
		groupName: about.profile?.name ?? group.name,
		members: fromRecords
			? rosterFromRecords(members)
			: rosterFromRows(await listMembers(db, group.id)),
		/** Which source the list above came from, so "the records are empty" can
		 *  never be rendered as "the group has no members". */
		rosterSource: fromRecords ? ('records' as const) : ('cache' as const),
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

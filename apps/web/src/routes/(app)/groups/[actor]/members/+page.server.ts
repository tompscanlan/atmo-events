import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { GROUP_MEMBERSHIP_COLLECTION, isMembershipKey } from '$lib/groups/members-record';
import { ASSIGNABLE_ROLES, can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout, spaceRecordUri } from '$lib/groups/server/about-read';
import {
	NO_MEMBER_RECORDS,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	rosterFromRecords,
	rosterFromRows
} from '$lib/groups/server/members-read';
import { loadPeople } from '$lib/groups/server/people';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { listJoinRequests, listMembers, rolePermissions } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** The roster is `membership` records in the members space, with the
 *  `memberships` rows as a copy. The page reads the records and falls back to
 *  the rows only when there are none to read. The gate uses the same source:
 *  when records exist, a DID with no membership record cannot see the roster,
 *  whatever a stale row says. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	const reader = await groupSpaceReader(platform!.env, db, group);
	// The back-link's name comes from the profile record, as on the group page.
	const members = reader ? await readGroupMembers(reader, group) : NO_MEMBER_RECORDS;
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };
	const fromRecords = hasMemberRecords(members);

	if (fromRecords ? !hasRecordedAccess(members, locals.did) : !canSeeMembers(membership)) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const roster = fromRecords
		? rosterFromRecords(members)
		: rosterFromRows(await listMembers(db, group.id));
	const pendingRequests = canAdmitMembers ? await listJoinRequests(db, group.id, 'pending') : [];
	const space = group.members_space_uri;

	return {
		group,
		membership,
		groupName: about.profile?.name ?? group.name,
		members: roster.map((entry) => ({
			...entry,
			/** The `membership` record behind the row, when the roster came from
			 *  records. A row from the cache has none to point at. */
			recordUri:
				fromRecords && space && isMembershipKey(entry.did)
					? spaceRecordUri(space, group.group_did, GROUP_MEMBERSHIP_COLLECTION, entry.did)
					: null
		})),
		/** So an empty record set is never shown as "the group has no members". */
		rosterSource: fromRecords ? ('records' as const) : ('cache' as const),
		pendingRequests,
		/** Avatar, name and handle for every DID the page shows. */
		people: await loadPeople(db, [
			...roster.map((entry) => entry.did),
			...pendingRequests.map((request) => request.did)
		]),
		// Shown so an admin can see what a role grants before assigning it.
		rolePermissions: await rolePermissions(db, group.id),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		canEjectMembers: can(membership.permissions, 'EJECT_MEMBERS'),
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

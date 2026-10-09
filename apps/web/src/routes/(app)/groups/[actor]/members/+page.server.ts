import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { GROUP_MEMBERSHIP_COLLECTION, isMembershipKey } from '$lib/groups/members-record';
import { ASSIGNABLE_ROLES, can } from '$lib/groups/permissions';
import {
	NO_MEMBER_RECORDS,
	hasMemberRecords,
	hasRecordedAccess,
	readGroupMembers,
	hasAuthzRecords,
	rolePermissionsFromRecords
} from '$lib/groups/server/members-read';
import { loadPeople } from '$lib/groups/server/people';
import { groupAcceptanceReader } from '$lib/groups/server/space-credential';
import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';
import { listJoinRequests, rolePermissions } from '$lib/groups/server/repo';
import type { GroupRow } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { spaceRecordUri } from '$lib/groups/ids';
/** Whether each member wrote their acceptance, read by DID with the group's space
 *  credential. Null when it cannot be read: the group has no linked session, or
 *  no credential could be had. The page then shows no state rather than a guess,
 *  and access is unaffected either way, since it comes from membership alone. */
async function readConfirmations(
	env: App.Platform['env'],
	db: D1Database,
	group: GroupRow,
	dids: string[]
): Promise<Map<string, boolean> | null> {
	const space = group.members_space_uri;
	if (!space || dids.length === 0) return null;
	try {
		const reader = await groupAcceptanceReader(env, group);
		return reader ? await reader.accepted(space, dids) : null;
	} catch (e) {
		console.error(`[groups] ${group.group_did}: acceptances could not be read:`, e);
		return null;
	}
}

/** The roster is `membership` records in the members space, with the
 *  `memberships` rows as a copy. The page reads the records and falls back to
 *  the rows only when there are none to read. The gate uses the same source:
 *  when records exist, a DID with no membership record cannot see the roster,
 *  whatever a stale row says. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const { group, membership, reader } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	// The back-link's name comes from the profile record, as on the group page.
	const [members, { groupName }] = await Promise.all([
		reader ? readGroupMembers(reader, group) : NO_MEMBER_RECORDS,
		groupHeader(db, group, reader)
	]);
	const fromRecords = hasMemberRecords(members);

	if (fromRecords ? !hasRecordedAccess(members, locals.did) : !canSeeMembers(membership)) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const { entries: roster } = await pageRoster(db, group, members, (dids) =>
		readConfirmations(platform!.env, db, group, dids)
	);
	const pendingRequests = canAdmitMembers ? await listJoinRequests(db, group.id, 'pending') : [];
	const space = group.members_space_uri;

	return {
		group,
		membership,
		groupName,
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
		// Shown so an admin can see what a role grants before assigning it: from
		// the binding records the gate reads, else the rows.
		rolePermissions: hasAuthzRecords(members)
			? rolePermissionsFromRecords(members)
			: await rolePermissions(db, group.id),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		canEjectMembers: can(membership.permissions, 'EJECT_MEMBERS'),
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

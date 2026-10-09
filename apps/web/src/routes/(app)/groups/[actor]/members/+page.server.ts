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
	rolePermissionsFromRecords,
	isUnfinishedRow,
	type GroupMembers
} from '$lib/groups/server/members-read';
import { listMembers } from '$lib/groups/server/db/roster';
import { loadPeople } from '$lib/groups/server/people';
import { groupAcceptanceReader } from '$lib/groups/server/space-credential';
import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';

import type { GroupRow } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { spaceRecordUri } from '$lib/groups/ids';
import { rolePermissions } from '$lib/groups/server/db/groups';
import { groupHost } from '$lib/groups/server/host';
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

/** Rows the records no longer back: a removal or an admission that stopped
 *  partway, which this site cannot tell apart. The roster is drawn from the
 *  records, so without this list such a member vanishes from the page with the
 *  removal still half done. The owner is left out: it cannot be removed, and
 *  Repair writes its record. */
async function unfinishedRemovals(
	db: D1Database,
	group: GroupRow,
	members: GroupMembers
): Promise<string[]> {
	const recorded = new Set(members.memberships.map((record) => record.subject));
	return (await listMembers(db, group.id))
		.map((row) => row.did)
		.filter((did) => !recorded.has(did) && did !== group.owner_did);
}

/** The roster is `membership` records in the members space, with the
 *  `memberships` rows as a copy. The page reads the records and falls back to
 *  the rows only when there are none to read. The gate uses the same source:
 *  when records exist, a DID with no membership record cannot see the roster,
 *  whatever a stale row says. The group's own account is the exception, as in
 *  `getCallerMembership`: it has no record and needs none. (Spec: FR-213.) */
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

	const isGroup = locals.did === group.group_did;
	if (
		!isGroup &&
		(fromRecords ? !hasRecordedAccess(members, locals.did) : !canSeeMembers(membership))
	) {
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	}

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const { entries: roster } = await pageRoster(db, group, members, (dids) =>
		readConfirmations(platform!.env, db, group, dids)
	);
	const canEjectMembers = can(membership.permissions, 'EJECT_MEMBERS');
	const unfinished =
		canEjectMembers && isUnfinishedRow(members) ? await unfinishedRemovals(db, group, members) : [];
	const pendingRequests = canAdmitMembers
		? await groupHost({ db, env: platform!.env, group }).listJoinRequests()
		: [];
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
			...pendingRequests.map((request) => request.did),
			...unfinished
		]),
		// Shown so an admin can see what a role grants before assigning it: from
		// the records the gate reads, else the rows' copy of atmo's bundles, which
		// grant nothing themselves.
		rolePermissions: hasAuthzRecords(members)
			? rolePermissionsFromRecords(members, group.group_did)
			: await rolePermissions(db, group.id),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		/** DIDs on the rows with no membership record, which only Remove
		 *  finishes. Shown to whoever may eject. */
		unfinished,
		canEjectMembers,
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

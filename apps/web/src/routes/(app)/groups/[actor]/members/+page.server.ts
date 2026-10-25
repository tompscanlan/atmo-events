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
import { gateCaller, type CallerSession } from '$lib/groups/server/caller';
import {
	credentialAcceptanceReader,
	isSpaceAccessDenied
} from '$lib/groups/server/space-credential';
import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';

import type { GroupSpaceReader } from '$lib/groups/server/about-read';
import type { GroupRow } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { spaceRecordUri } from '$lib/groups/ids';
import { rolePermissions } from '$lib/groups/server/db/groups';
import { pendingRequestsFor } from '$lib/groups/server/host';
/** Whether each member wrote their acceptance, read by DID with the viewer's own
 *  space credential. Null when it cannot be read: the viewer's sign-in reads no
 *  spaces, or no credential could be had. The page then shows no state rather
 *  than a guess, and access is unaffected either way, since it comes from
 *  membership alone. */
async function readConfirmations(
	viewer: CallerSession | null,
	group: GroupRow,
	dids: string[]
): Promise<Map<string, boolean> | null> {
	const space = group.members_space_uri;
	if (!viewer || !space || dids.length === 0) return null;
	try {
		return await credentialAcceptanceReader(viewer, group.group_did).accepted(space, dids);
	} catch (e) {
		console.error(`[groups] ${group.group_did}: acceptances could not be read:`, e);
		return null;
	}
}

/** Rows the records no longer back: a removal or an admission that stopped
 *  partway, which this site cannot tell apart. The roster is drawn from the
 *  records, so without this list such a member vanishes from the page with the
 *  removal still half done. */
async function unfinishedRemovals(
	db: D1Database,
	group: GroupRow,
	members: GroupMembers
): Promise<string[]> {
	const recorded = new Set(members.memberships.map((record) => record.subject));
	return (await listMembers(db, group.id))
		.map((row) => row.did)
		.filter((did) => !recorded.has(did));
}

/** The members space as the caller may read it: the records, or none when the
 *  host does not let them in, which the gate already read as off the roster. */
async function readRosterSpace(
	reader: GroupSpaceReader | null,
	group: GroupRow
): Promise<GroupMembers> {
	if (!reader) return NO_MEMBER_RECORDS;
	try {
		return await readGroupMembers(reader, group);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return NO_MEMBER_RECORDS;
		throw e;
	}
}

/** The roster is `membership` records in the members space, with the
 *  `memberships` rows as a copy, read with the caller's own access. The page
 *  reads the records and falls back to the rows only when there are none to
 *  read. The gate uses the same source: when records exist, a DID with no
 *  membership record cannot see the roster, whatever a stale row says. A caller
 *  off the roster is refused before anything is read with their access. The
 *  group's own account is the exception, as in `getCallerMembership`: it has no
 *  record and needs none. (Spec: FR-213.) */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const viewer = await gateCaller(locals.did, locals.session);
	const { group, membership, reader } = await groupRouteContext(db, params.actor, viewer, {
		signInNotice: true
	});

	const isGroup = locals.did === group.group_did;
	const refuse = () =>
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	// A member whose sign-in carries no grant for the group, such as its creator
	// right after the create, gets a page that says when a new sign-in shows them
	// the roster. Nothing is read from the members space for them.
	if (!isGroup && !canSeeMembers(membership) && membership.signIn) {
		const { groupName } = await groupHeader(db, group, reader);
		return { group, groupName, signIn: membership.signIn };
	}
	if (!isGroup && !canSeeMembers(membership)) refuse();

	// The back-link's name comes from the profile record, as on the group page.
	const [members, { groupName }] = await Promise.all([
		readRosterSpace(reader, group),
		groupHeader(db, group, reader)
	]);
	const fromRecords = hasMemberRecords(members);
	if (!isGroup && fromRecords && !hasRecordedAccess(members, locals.did)) refuse();

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const { entries: roster } = await pageRoster(db, group, members, (dids) =>
		readConfirmations(viewer, group, dids)
	);
	const canEjectMembers = can(membership.permissions, 'EJECT_MEMBERS');
	const unfinished =
		canEjectMembers && isUnfinishedRow(members) ? await unfinishedRemovals(db, group, members) : [];
	const pendingRequests = canAdmitMembers
		? await pendingRequestsFor(
				{ db, env: platform!.env, group },
				{ callerDid: locals.did!, reader }
			)
		: [];
	const space = group.members_space_uri;

	return {
		group,
		membership,
		groupName,
		signIn: null,
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
		pendingRequests: pendingRequests ?? [],
		/** The viewer may admit, but holds no group session to ask the host with. */
		requestsNeedLink: pendingRequests === null,
		/** Avatar, name and handle for every DID the page shows. */
		people: await loadPeople(db, [
			...roster.map((entry) => entry.did),
			...(pendingRequests ?? []).map((request) => request.did),
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

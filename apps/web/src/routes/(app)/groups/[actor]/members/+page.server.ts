import { error } from '@sveltejs/kit';
import { canSeeMembers } from '$lib/groups/access';
import { ASSIGNABLE_ROLES, can } from '$lib/groups/permissions';
import {
	NO_MEMBER_RECORDS,
	hasMemberRecords,
	readGroupMembers,
	rolePermissionsFromRecords,
	rolesForDid,
	type GroupMembers
} from '$lib/groups/server/members-read';
import { listMembers } from '$lib/groups/server/db/roster';
import { loadPeople } from '$lib/groups/server/people';
import { gateCaller } from '$lib/groups/server/caller';
import { isSpaceAccessDenied } from '$lib/groups/server/space-credential';
import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';
import type { GroupSpaceReader } from '$lib/groups/server/about-read';
import { publicGroup, type GroupRow } from '$lib/groups/types';
import type { PageServerLoad } from './$types';
import { pendingRequestsFor } from '$lib/groups/server/host';

/** Rows the records no longer back: a removal or an admission that stopped partway,
 *  which only Remove finishes. */
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

/** Read with the caller's own access; the rows stand in only when the space holds no
 *  records. The group's own account needs no record. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	const viewer = await gateCaller(locals.did, locals.session);
	const { group, membership, reader } = await groupRouteContext(db, params.actor, viewer, {
		signInNotice: true
	});

	const isGroup = locals.did === group.group_did;
	const refuse = () =>
		error(403, locals.did ? 'Only members can see this roster' : 'Sign in to see members');
	if (!isGroup && !canSeeMembers(membership) && membership.signIn) {
		const { groupName } = await groupHeader(db, group, reader);
		return { group: publicGroup(group), groupName, signIn: true as const };
	}
	if (!isGroup && !canSeeMembers(membership)) refuse();

	const [members, { groupName }] = await Promise.all([
		readRosterSpace(reader, group),
		groupHeader(db, group, reader)
	]);
	const fromRecords = hasMemberRecords(members);
	if (!isGroup && fromRecords && rolesForDid(members, locals.did).length === 0) refuse();

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const canEjectMembers = can(membership.permissions, 'EJECT_MEMBERS');
	const roster = await pageRoster(db, group, members);
	const unfinished =
		canEjectMembers && fromRecords ? await unfinishedRemovals(db, group, members) : [];
	const pendingRequests = canAdmitMembers
		? await pendingRequestsFor(
				{ db, env: platform!.env, group },
				{ callerDid: locals.did!, reader }
			)
		: [];

	return {
		group: publicGroup(group),
		membership,
		groupName,
		signIn: null,
		members: roster,
		pendingRequests: pendingRequests ?? [],
		/** The viewer may admit, but holds no group session to ask the host with. */
		requestsNeedLink: pendingRequests === null,
		people: await loadPeople(db, [
			...roster.map((entry) => entry.did),
			...(pendingRequests ?? []).map((request) => request.did),
			...unfinished
		]),
		rolePermissions: rolePermissionsFromRecords(members, group.group_did),
		assignableRoles: ASSIGNABLE_ROLES,
		canAdmitMembers,
		unfinished,
		canEjectMembers,
		canAssignRoles: can(membership.permissions, 'ASSIGN_ROLES')
	};
};

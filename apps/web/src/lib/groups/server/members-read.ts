// A group's roster and authz config, read from its members space. The records win: a
// DID with no `membership` record has no access whatever its row says. A failed read
// throws, because "failed" read as "empty" would hand the gate to the rows.
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	isMembershipKey,
	parseGroupAccess,
	parseGroupGrants,
	parseGroupMembership,
	parseGroupRole,
	type GroupAccessFields
} from '../members-record';
import { memberGrants, permissionsFor } from '../grants';
import { GROUP_ROLES, primaryRole, type GroupPermission } from '../permissions';
import type { RoleGrant, WriteGrants } from '../scopes';
import type { GroupRow, MemberRow, RosterEntry } from '../types';
import type { GroupSpaceReader, GroupSpaceRecord } from './about-read';

export interface GroupMembershipRecord {
	uri: string;
	rkey: string;
	subject: string;
	roles: string[];
	createdAt: string | null;
}

export interface GroupMembers {
	memberships: GroupMembershipRecord[];
	roles: string[];
	permissions: RoleGrant[] | null;
	access: GroupAccessFields | null;
}

export const NO_MEMBER_RECORDS: GroupMembers = {
	memberships: [],
	roles: [],
	permissions: null,
	access: null
};

// A host that ignored the collection filter must not turn other records into memberships.
function toMembershipRecord(record: GroupSpaceRecord | null): GroupMembershipRecord | null {
	if (!record || record.collection !== GROUP_MEMBERSHIP_COLLECTION) return null;
	const parsed = parseGroupMembership(record.value, record.rkey);
	return parsed ? { uri: record.uri, rkey: record.rkey, ...parsed } : null;
}

async function readAuthz(
	reader: GroupSpaceReader,
	space: string,
	repo: string
): Promise<Pick<GroupMembers, 'roles' | 'permissions'>> {
	const [permissionsRecord, roleRecords] = await Promise.all([
		reader.get({
			space,
			repo,
			collection: GROUP_PERMISSIONS_COLLECTION,
			rkey: GROUP_PERMISSIONS_RKEY
		}),
		reader.list({ space, repo, collection: GROUP_ROLE_COLLECTION })
	]);
	const known = (id: string) => {
		const at = (GROUP_ROLES as readonly string[]).indexOf(id);
		return at < 0 ? GROUP_ROLES.length : at;
	};
	const roles = roleRecords
		.filter((record) => record.collection === GROUP_ROLE_COLLECTION)
		.flatMap((record) => parseGroupRole(record.value, record.rkey)?.id ?? [])
		.sort((a, b) => known(a) - known(b));
	return {
		roles,
		permissions: permissionsRecord ? parseGroupGrants(permissionsRecord.value) : null
	};
}

export async function readGroupMembers(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>
): Promise<GroupMembers> {
	const space = group.members_space_uri;
	if (!space) return NO_MEMBER_RECORDS;
	const repo = group.group_did;
	const [accessRecord, authz, membershipRecords] = await Promise.all([
		reader.get({ space, repo, collection: GROUP_ACCESS_COLLECTION, rkey: GROUP_ACCESS_RKEY }),
		readAuthz(reader, space, repo),
		reader.list({ space, repo, collection: GROUP_MEMBERSHIP_COLLECTION })
	]);
	return {
		memberships: membershipRecords.flatMap((record) => toMembershipRecord(record) ?? []),
		...authz,
		access: accessRecord ? parseGroupAccess(accessRecord.value) : null
	};
}

export async function readMembership(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>,
	did: string
): Promise<GroupMembershipRecord | null> {
	const space = group.members_space_uri;
	if (!space || !isMembershipKey(did)) return null;
	return toMembershipRecord(
		await reader.get({
			space,
			repo: group.group_did,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: did
		})
	);
}

export async function readCallerAuthz(
	reader: GroupSpaceReader,
	group: GroupRow,
	did: string
): Promise<GroupMembers> {
	const space = group.members_space_uri;
	if (!space) return NO_MEMBER_RECORDS;
	const repo = group.group_did;
	const [membership, authz, accessRecord] = await Promise.all([
		readMembership(reader, group, did),
		readAuthz(reader, space, repo),
		reader.get({ space, repo, collection: GROUP_ACCESS_COLLECTION, rkey: GROUP_ACCESS_RKEY })
	]);
	return {
		memberships: membership ? [membership] : [],
		...authz,
		access: accessRecord ? parseGroupAccess(accessRecord.value) : null
	};
}

export function grantsForRoles(
	members: GroupMembers,
	roles: Iterable<string>,
	aboutAccess: GroupAccessFields | null = null
): WriteGrants {
	return memberGrants({
		roles,
		permissions: members.permissions,
		membersAccess: members.access,
		aboutAccess
	});
}

/** Empty for an unknown or anonymous caller, which must mean no access, never a default. */
export function rolesForDid(members: GroupMembers, did: string | null): string[] {
	if (!did) return [];
	return members.memberships.find((record) => record.subject === did)?.roles ?? [];
}

export function resolveActor(
	members: GroupMembers,
	actorDid: string | null,
	groupDid: string,
	aboutAccess: GroupAccessFields | null = null
): { grants: WriteGrants; permissions: Set<GroupPermission> } {
	const grants = grantsForRoles(members, rolesForDid(members, actorDid), aboutAccess);
	return { grants, permissions: permissionsFor(grants, groupDid) };
}

export function rolePermissionsFromRecords(
	members: GroupMembers,
	groupDid: string
): Record<string, GroupPermission[]> {
	return Object.fromEntries(
		members.roles.map((role) => [
			role,
			[...permissionsFor(grantsForRoles(members, [role]), groupDid)]
		])
	);
}

/** An empty members space means the records were never written, not an empty group. */
export function hasMemberRecords(members: GroupMembers): boolean {
	return members.memberships.length > 0;
}

export function createdAtMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

function byRosterOrder(a: RosterEntry, b: RosterEntry): number {
	return a.created_at - b.created_at || a.did.localeCompare(b.did);
}

export function rosterFromRecords(members: GroupMembers): RosterEntry[] {
	return members.memberships
		.flatMap((record) => {
			const role = primaryRole(record.roles);
			return role ? [{ did: record.subject, role, created_at: createdAtMs(record.createdAt) }] : [];
		})
		.sort(byRosterOrder);
}

export function rosterFromRows(rows: MemberRow[]): RosterEntry[] {
	return rows.map((row) => ({ did: row.did, role: row.role, created_at: row.created_at }));
}

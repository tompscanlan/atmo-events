// Reads a group's roster and authz config from its members space. The records win: the `memberships` rows are a
// cache, and a DID with no `membership` record has no access whatever its row
// says.
//
// Reads use the group's own session, as in `about-read.ts`, so only records the
// group account wrote are readable. An absent record reads as absent. A failed
// read throws, because "failed" read as "empty" would hand the gate to the rows.
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	isMembershipKey,
	parseEventBindings,
	parseGroupAccess,
	parseGroupGrants,
	parseGroupMembership,
	parseGroupRole,
	type GroupAccessFields,
	type GroupBindingsFields
} from '../members-record';
import { communityPermissions, memberGrants } from '../grants';
import {
	GROUP_ROLES,
	resolvePermissions,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import type { RoleGrant, WriteGrants } from '../scopes';
import type { GroupRow, MemberRow, RosterEntry } from '../types';
import type { GroupSpaceReader, GroupSpaceRecord } from './about-read';

/** A membership record. Its `rkey` is the member DID. */
export interface GroupMembershipRecord {
	uri: string;
	rkey: string;
	subject: string;
	roles: GroupRoleName[];
	/** Every role the record names, known or not, for the write gate. */
	roleIds: string[];
	createdAt: string | null;
}

export interface GroupRoleRecord {
	/** The role id, which is also the record key. */
	id: GroupRoleName;
	uri: string;
}

export interface GroupMembers {
	memberships: GroupMembershipRecord[];
	/** Empty when the group has no authz config yet. */
	roles: GroupRoleRecord[];
	/** The `permissions` record's grants, as scopes, or null when absent. */
	permissions: RoleGrant[] | null;
	/** The two modality (event) actions: same shape, separate record. */
	eventPermissions: GroupBindingsFields | null;
	/** The members space's read policy as a record, or null when absent. */
	access: GroupAccessFields | null;
}

export const NO_MEMBER_RECORDS: GroupMembers = {
	memberships: [],
	roles: [],
	permissions: null,
	eventPermissions: null,
	access: null
};

/** A membership record as read, or null when it is not one: another
 *  collection (a host that ignored the filter must not turn other records into
 *  memberships), or a value that does not parse. */
function toMembershipRecord(record: GroupSpaceRecord | null): GroupMembershipRecord | null {
	if (!record || record.collection !== GROUP_MEMBERSHIP_COLLECTION) return null;
	const parsed = parseGroupMembership(record.value, record.rkey);
	if (!parsed) return null;
	return {
		uri: record.uri,
		rkey: record.rkey,
		subject: parsed.subject,
		roles: parsed.roles,
		roleIds: parsed.roleIds,
		createdAt: parsed.createdAt
	};
}

/** The authz config: both binding records and the role list, read together. An
 *  unknown role is dropped, since nothing could resolve its grant. */
async function readAuthz(
	reader: GroupSpaceReader,
	space: string,
	repo: string
): Promise<Pick<GroupMembers, 'roles' | 'permissions' | 'eventPermissions'>> {
	const binding = (collection: string) =>
		reader.get({ space, repo, collection, rkey: GROUP_PERMISSIONS_RKEY });
	const [permissionsRecord, eventPermissionsRecord, roleRecords] = await Promise.all([
		binding(GROUP_PERMISSIONS_COLLECTION),
		binding(GROUP_EVENT_PERMISSIONS_COLLECTION),
		reader.list({ space, repo, collection: GROUP_ROLE_COLLECTION })
	]);
	const roles: GroupRoleRecord[] = [];
	for (const record of roleRecords) {
		if (record.collection !== GROUP_ROLE_COLLECTION) continue;
		const role = parseGroupRole(record.value, record.rkey);
		if (role) roles.push({ id: role.id, uri: record.uri });
	}
	roles.sort((a, b) => GROUP_ROLES.indexOf(a.id) - GROUP_ROLES.indexOf(b.id));
	return {
		roles,
		permissions: permissionsRecord ? parseGroupGrants(permissionsRecord.value) : null,
		eventPermissions: eventPermissionsRecord
			? parseEventBindings(eventPermissionsRecord.value)
			: null
	};
}

/** A group's roster and authz config as records. The reads are independent and
 *  go out together, so the page waits for one round trip. */
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
	const memberships: GroupMembershipRecord[] = [];
	for (const record of membershipRecords) {
		const membership = toMembershipRecord(record);
		if (membership) memberships.push(membership);
	}
	return {
		memberships,
		...authz,
		access: accessRecord ? parseGroupAccess(accessRecord.value) : null
	};
}

/** One DID's membership record, by its key, or null when there is none. */
export async function readMembership(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>,
	did: string
): Promise<GroupMembershipRecord | null> {
	const space = group.members_space_uri;
	// A DID that cannot be a record key cannot have a membership record.
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

/** The grants every held role gets in `permissions` and in the `access` records
 *  read, for the write gate. A role id this build does not know still counts. */
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

/**
 * The names held roles answer yes to: the community four from their scopes in
 * `permissions` and `access` (../grants.ts), and the event two from
 * `eventPermissions`. Reading only `permissions` would drop every event grant.
 * There are no deny rules and no hierarchy. An absent record adds nothing, so a
 * group with no authz records resolves to the empty set, not a default.
 */
export function effectivePermissions(
	members: GroupMembers,
	roles: Iterable<string>,
	groupDid: string,
	aboutAccess: GroupAccessFields | null = null
): Set<GroupPermission> {
	const held = new Set(roles);
	const grants: GroupPermission[][] = [
		communityPermissions(grantsForRoles(members, held, aboutAccess), groupDid)
	];
	for (const binding of members.eventPermissions?.bindings ?? []) {
		if (held.has(binding.role)) grants.push(binding.permissions);
	}
	return resolvePermissions(grants);
}

/** What each recorded role answers yes to, for a page's role table, from the
 *  records the gate reads. */
export function rolePermissionsFromRecords(
	members: GroupMembers,
	groupDid: string
): Record<string, GroupPermission[]> {
	return Object.fromEntries(
		members.roles.map((role) => [role.id, [...effectivePermissions(members, [role.id], groupDid)]])
	);
}

/** Whether the space holds an authz config at all. None means the config was
 *  never written, not that the group grants nothing. */
export function hasAuthzRecords(members: GroupMembers): boolean {
	return members.roles.length > 0 && members.permissions !== null;
}

/**
 * What `actorDid` may do, as a pure function of the records: no D1, no session
 * and no request, so another app could reuse it. Their grants are what the write
 * gate checks; the names are what pages ask. Reading the records belongs to
 * `getCallerMembership`.
 */
export function resolveActor(
	members: GroupMembers,
	actorDid: string | null,
	groupDid: string,
	aboutAccess: GroupAccessFields | null = null
): { grants: WriteGrants; permissions: Set<GroupPermission> } {
	const roles = roleIdsForDid(members, actorDid);
	return {
		grants: grantsForRoles(members, roles, aboutAccess),
		permissions: effectivePermissions(members, roles, groupDid, aboutAccess)
	};
}

/** The records the resolver needs for one caller: their own membership (its
 *  rkey is their DID, so one `getRecord`), the authz config, and the members
 *  space's access record, whose grants count in that space. The result holds at
 *  most the caller's own membership. A reader error propagates, so the gate fails
 *  closed and never falls back to the rows. */
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

/** The roles a DID holds according to the records. Empty for an unknown or
 *  anonymous caller, which must mean no access, never a default. */
export function rolesForDid(members: GroupMembers, did: string | null): GroupRoleName[] {
	if (!did) return [];
	const found = members.memberships.find((record) => record.subject === did);
	return found ? found.roles : [];
}

/** Every role id `did`'s record names, known or not. Empty for an unknown or
 *  anonymous caller. */
export function roleIdsForDid(members: GroupMembers, did: string | null): string[] {
	if (!did) return [];
	const found = members.memberships.find((record) => record.subject === did);
	return found ? found.roleIds : [];
}

/** Whether the records grant `did` any role this build knows. */
export function hasRecordedAccess(members: GroupMembers, did: string | null): boolean {
	return rolesForDid(members, did).length > 0;
}

/** Whether a roster can come from the records. An empty members space means
 *  the records were never written, not that the group has no members. */
export function hasMemberRecords(members: GroupMembers): boolean {
	return members.memberships.length > 0;
}

/** Whether a roster row with no membership record in `members` is one a removal
 *  or an admission left unfinished, rather than a group whose records were never
 *  fully written: the authz config and other members' records are there. Such a
 *  row grants nothing, and only removing it finishes it. */
export function isUnfinishedRow(members: GroupMembers): boolean {
	return hasAuthzRecords(members) && hasMemberRecords(members);
}

/** Who a cold rebuild (`./rebuild.ts`) records as the group's creator: the
 *  member whose `admin` record is the earliest, a record with no date after any
 *  with one, and the DID breaking a tie. `null` when no record grants `admin`, so
 *  the rebuild refuses. The creator is an ordinary admin, so a later admin
 *  standing in for one who left grants nothing extra. */
export function creatorDidFromRecords(members: GroupMembers): string | null {
	const when = (record: GroupMembershipRecord) =>
		createdAtMs(record.createdAt) || Number.POSITIVE_INFINITY;
	const admins = members.memberships
		.filter((record) => record.roles.includes('admin'))
		.sort((a, b) => when(a) - when(b) || a.subject.localeCompare(b.subject));
	return admins[0]?.subject ?? null;
}

/** The strongest role held, in `GROUP_ROLES` order. A D1 row holds one role,
 *  and picking the weaker one would silently demote. Only a record another app
 *  wrote can hold two. */
export function primaryRole(roles: readonly GroupRoleName[]): GroupRoleName | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? null;
}

export function createdAtMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** The order `listMembers` gets from SQL, by join time, so records and cache
 *  render alike. DID breaks a tie between records written in the same
 *  millisecond. */
function byRosterOrder(a: RosterEntry, b: RosterEntry): number {
	return a.created_at - b.created_at || a.did.localeCompare(b.did);
}

/**
 * The roster as records say it is. A record with no known role grants no access,
 * so it is dropped rather than shown as a member.
 *
 * The roster is the `membership` records. A member who also wrote an
 * `acceptance` is confirmed, and one who did not is shown as unconfirmed, not
 * hidden, because most members' PDSes cannot hold an acceptance yet. An
 * acceptance with no membership adds no one. With no acceptances read
 * (`null`), every entry's state is unknown. (Spec: FR-204.)
 */
export function rosterFromRecords(
	members: GroupMembers,
	acceptances: ReadonlyMap<string, boolean> | null = null
): RosterEntry[] {
	const roster: RosterEntry[] = [];
	for (const record of members.memberships) {
		const role = primaryRole(record.roles);
		if (!role) continue;
		roster.push({
			did: record.subject,
			role,
			created_at: createdAtMs(record.createdAt),
			confirmed: acceptances ? acceptances.get(record.subject) === true : null
		});
	}
	return roster.sort(byRosterOrder);
}

/** The same shape from the cache, so a page renders one type either way. The
 *  cache holds no acceptance, so no entry's state is known. */
export function rosterFromRows(rows: MemberRow[]): RosterEntry[] {
	return rows.map((row) => ({
		did: row.did,
		role: row.role,
		created_at: row.created_at,
		confirmed: null
	}));
}

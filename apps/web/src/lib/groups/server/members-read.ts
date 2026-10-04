// Reads a group's roster and authz config from its members space, and repairs
// the D1 projection from them. The records win: the `memberships` rows are a
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
	GROUP_SPACE_COLLECTION,
	isMembershipKey,
	parseGroupAccess,
	parseGroupBindings,
	parseGroupMembership,
	parseGroupRole,
	parseGroupSpace,
	type GroupAccessFields,
	type GroupBindingsFields
} from '../members-record';
import {
	GROUP_ROLES,
	resolvePermissions,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import type { GroupRow, MemberRow, RosterEntry } from '../types';
import type { GroupSpaceReader } from './about-read';
import { ensureGroupsSchema } from './schema';

/** A membership record. Its `rkey` is the member DID. */
export interface GroupMembershipRecord {
	uri: string;
	rkey: string;
	subject: string;
	roles: GroupRoleName[];
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
	/** The four community actions bound to roles, or null when absent. */
	permissions: GroupBindingsFields | null;
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

/** Records first, then the cache. A page says which one it rendered. */
export type RosterSource = 'records' | 'cache';

/** A group's roster and authz config as records. The five reads are
 *  independent and go out together, so the page waits for one round trip. */
export async function readGroupMembers(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>
): Promise<GroupMembers> {
	const space = group.members_space_uri;
	if (!space) return NO_MEMBER_RECORDS;
	const repo = group.group_did;

	const [accessRecord, permissionsRecord, eventPermissionsRecord, membershipRecords, roleRecords] =
		await Promise.all([
			reader.get({ space, repo, collection: GROUP_ACCESS_COLLECTION, rkey: GROUP_ACCESS_RKEY }),
			reader.get({
				space,
				repo,
				collection: GROUP_PERMISSIONS_COLLECTION,
				rkey: GROUP_PERMISSIONS_RKEY
			}),
			reader.get({
				space,
				repo,
				collection: GROUP_EVENT_PERMISSIONS_COLLECTION,
				rkey: GROUP_PERMISSIONS_RKEY
			}),
			reader.list({ space, repo, collection: GROUP_MEMBERSHIP_COLLECTION }),
			reader.list({ space, repo, collection: GROUP_ROLE_COLLECTION })
		]);

	const memberships: GroupMembershipRecord[] = [];
	for (const record of membershipRecords) {
		// Checked again, as in `readGroupAbout`: a host that ignored the
		// collection parameter must not turn other records into memberships.
		if (record.collection !== GROUP_MEMBERSHIP_COLLECTION) continue;
		const parsed = parseGroupMembership(record.value, record.rkey);
		if (!parsed) continue;
		memberships.push({
			uri: record.uri,
			rkey: record.rkey,
			subject: parsed.subject,
			roles: parsed.roles,
			createdAt: parsed.createdAt
		});
	}

	const roles: GroupRoleRecord[] = [];
	for (const record of roleRecords) {
		if (record.collection !== GROUP_ROLE_COLLECTION) continue;
		const parsed = parseGroupRole(record.value, record.rkey);
		// An unknown role is dropped: nothing could resolve its grant.
		if (!parsed) continue;
		roles.push({ id: parsed.id, uri: record.uri });
	}
	roles.sort((a, b) => GROUP_ROLES.indexOf(a.id) - GROUP_ROLES.indexOf(b.id));

	return {
		memberships,
		roles,
		permissions: permissionsRecord
			? parseGroupBindings('community', permissionsRecord.value)
			: null,
		eventPermissions: eventPermissionsRecord
			? parseGroupBindings('modality', eventPermissionsRecord.value)
			: null,
		access: accessRecord ? parseGroupAccess(accessRecord.value) : null
	};
}

/** One entry in the group's index of its spaces. */
export interface GroupSpaceIndexEntry {
	rkey: string;
	space: string;
}

/** The group's index of its spaces, oldest entry first. Read only by the writer that
 *  keeps it whole, so it is not one of `readGroupMembers`' reads. */
export async function readGroupSpaceIndex(
	reader: GroupSpaceReader,
	group: Pick<GroupRow, 'group_did' | 'members_space_uri'>
): Promise<GroupSpaceIndexEntry[]> {
	const space = group.members_space_uri;
	if (!space) return [];
	const entries: GroupSpaceIndexEntry[] = [];
	for (const record of await reader.list({
		space,
		repo: group.group_did,
		collection: GROUP_SPACE_COLLECTION
	})) {
		if (record.collection !== GROUP_SPACE_COLLECTION) continue;
		const parsed = parseGroupSpace(record.value);
		if (parsed) entries.push({ rkey: record.rkey, space: parsed.space });
	}
	// A TID sorts by time, so the first entry for a space is its oldest.
	return entries.sort((a, b) => a.rkey.localeCompare(b.rkey));
}

/**
 * The union of what every held role is bound to, across both binding records.
 * Reading only `permissions` would drop every event grant. There are no deny
 * rules and no hierarchy. An absent record adds nothing, so a group with no
 * authz records resolves to the empty set, not a default.
 */
export function effectivePermissions(
	members: GroupMembers,
	roles: Iterable<GroupRoleName>
): Set<GroupPermission> {
	const held = new Set(roles);
	const grants: GroupPermission[][] = [];
	for (const record of [members.permissions, members.eventPermissions]) {
		for (const binding of record?.bindings ?? []) {
			if (held.has(binding.role)) grants.push(binding.permissions);
		}
	}
	return resolvePermissions(grants);
}

/** Whether the space holds an authz config at all. None means the config was
 *  never written, not that the group grants nothing. */
export function hasAuthzRecords(members: GroupMembers): boolean {
	return members.roles.length > 0 && members.permissions !== null;
}

/**
 * What `actorDid` may do, as a pure function of the records: no D1, no session
 * and no request, so another app could reuse it. Reading the records and the
 * fallback for a group with no config belong to `getCallerMembership`.
 */
export function resolveActorPermissions(
	members: GroupMembers,
	actorDid: string | null
): Set<GroupPermission> {
	return effectivePermissions(members, rolesForDid(members, actorDid));
}

/** The records the resolver needs for one caller: their own membership (its
 *  rkey is their DID, so one `getRecord`), both binding records, and the role
 *  list. A reader error propagates, so the gate fails closed and never falls
 *  back to the rows. */
export async function readCallerAuthz(
	reader: GroupSpaceReader,
	group: GroupRow,
	did: string
): Promise<GroupMembers> {
	const space = group.members_space_uri;
	if (!space) return NO_MEMBER_RECORDS;
	const repo = group.group_did;

	const [membershipRecord, permissionsRecord, eventPermissionsRecord, roleRecords] =
		await Promise.all([
			// A DID that cannot be a record key cannot have a membership record.
			isMembershipKey(did)
				? reader.get({ space, repo, collection: GROUP_MEMBERSHIP_COLLECTION, rkey: did })
				: null,
			reader.get({
				space,
				repo,
				collection: GROUP_PERMISSIONS_COLLECTION,
				rkey: GROUP_PERMISSIONS_RKEY
			}),
			reader.get({
				space,
				repo,
				collection: GROUP_EVENT_PERMISSIONS_COLLECTION,
				rkey: GROUP_PERMISSIONS_RKEY
			}),
			reader.list({ space, repo, collection: GROUP_ROLE_COLLECTION })
		]);

	const memberships: GroupMembershipRecord[] = [];
	const parsed =
		membershipRecord && membershipRecord.collection === GROUP_MEMBERSHIP_COLLECTION
			? parseGroupMembership(membershipRecord.value, membershipRecord.rkey)
			: null;
	if (membershipRecord && parsed) {
		memberships.push({
			uri: membershipRecord.uri,
			rkey: membershipRecord.rkey,
			subject: parsed.subject,
			roles: parsed.roles,
			createdAt: parsed.createdAt
		});
	}

	const roles: GroupRoleRecord[] = [];
	for (const record of roleRecords) {
		if (record.collection !== GROUP_ROLE_COLLECTION) continue;
		const role = parseGroupRole(record.value, record.rkey);
		if (role) roles.push({ id: role.id, uri: record.uri });
	}

	return {
		memberships,
		roles,
		permissions: permissionsRecord
			? parseGroupBindings('community', permissionsRecord.value)
			: null,
		eventPermissions: eventPermissionsRecord
			? parseGroupBindings('modality', eventPermissionsRecord.value)
			: null,
		access: null
	};
}

/** The roles a DID holds according to the records. Empty for an unknown or
 *  anonymous caller, which must mean no access, never a default. */
export function rolesForDid(members: GroupMembers, did: string | null): GroupRoleName[] {
	if (!did) return [];
	const found = members.memberships.find((record) => record.subject === did);
	return found ? found.roles : [];
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

/** The owner DID, from the record that grants the owner role. A cold rebuild
 *  (`./rebuild.ts`) needs it, and the schema makes a guessed owner permanent,
 *  so `null` means refuse, never guess. */
export function ownerDidFromRecords(members: GroupMembers): string | null {
	const owner = members.memberships.find((record) => record.roles.includes('owner'));
	return owner ? owner.subject : null;
}

/** The strongest role held, in `GROUP_ROLES` order. A D1 row holds one role,
 *  and picking the weaker one would silently demote. Only a record another app
 *  wrote can hold two. */
function primaryRole(roles: readonly GroupRoleName[]): GroupRoleName | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? null;
}

function createdAtMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** The order `listMembers` gets from SQL, so records and cache render alike.
 *  DID breaks a tie between records written in the same millisecond. */
function byRosterOrder(a: RosterEntry, b: RosterEntry): number {
	const rank = (entry: RosterEntry) => (entry.role === 'owner' ? 0 : 1);
	return rank(a) - rank(b) || a.created_at - b.created_at || a.did.localeCompare(b.did);
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
			// A record means access. A revocation deletes the record.
			status: 'active',
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
		status: row.status,
		created_at: row.created_at,
		confirmed: null
	}));
}

export interface MembersRebuildResult {
	/** Rows inserted or corrected from a record. */
	restored: string[];
	/** Rows that already agreed with their record. */
	unchanged: string[];
	/** Roster rows with no membership record. Reported, never deleted: a failed
	 *  grant and a half-done revocation both leave one, and the gate denies both. */
	orphans: string[];
	/** Records that could not be projected, with the reason. */
	skipped: { did: string; reason: string }[];
}

/**
 * Rebuild the `memberships` projection from the records. It is additive: it
 * writes what the records say and touches nothing else, so dropped rows come
 * back. The owner row is inserted, never updated, because the schema refuses
 * any change to it. A record that disagrees with it is skipped with a reason.
 */
export async function rebuildGroupMembers(
	db: D1Database,
	reader: GroupSpaceReader,
	group: GroupRow
): Promise<MembersRebuildResult> {
	return projectGroupMembers(db, await readGroupMembers(reader, group), group);
}

/** `rebuildGroupMembers` over records already read, so a cold rebuild that
 *  needed them to find the owner does not read the members space twice. */
export async function projectGroupMembers(
	db: D1Database,
	members: GroupMembers,
	group: GroupRow
): Promise<MembersRebuildResult> {
	await ensureGroupsSchema(db);
	const result: MembersRebuildResult = { restored: [], unchanged: [], orphans: [], skipped: [] };

	const roleRows = await db
		.prepare(`SELECT id, name FROM roles WHERE group_id = ?`)
		.bind(group.id)
		.all<{ id: string; name: GroupRoleName }>();
	const roleId = new Map<string, string>();
	for (const row of roleRows.results ?? []) roleId.set(row.name, row.id);

	const existing = await db
		.prepare(
			`SELECT m.did, m.role_id, m.status, r.name AS role
			 FROM memberships m JOIN roles r ON r.id = m.role_id
			 WHERE m.group_id = ?`
		)
		.bind(group.id)
		.all<{ did: string; role_id: string; status: string; role: GroupRoleName }>();
	const rows = new Map<string, { role: GroupRoleName; status: string }>();
	for (const row of existing.results ?? [])
		rows.set(row.did, { role: row.role, status: row.status });

	const now = Date.now();
	const recorded = new Set<string>();

	for (const record of members.memberships) {
		const did = record.subject;
		// A subject that cannot be a record key would be an unaddressable member.
		if (!isMembershipKey(did)) {
			result.skipped.push({ did, reason: 'subject is not a usable record key' });
			continue;
		}
		recorded.add(did);

		const role = primaryRole(record.roles);
		if (!role) {
			result.skipped.push({ did, reason: 'the record grants no role this build knows' });
			continue;
		}
		const target = roleId.get(role);
		if (!target) {
			result.skipped.push({ did, reason: `this group has no ${role} role row` });
			continue;
		}

		const row = rows.get(did);

		// The schema decides the owner. A disagreeing record is reported, not
		// applied, but a missing owner row is still inserted.
		if (did === group.owner_did) {
			if (role !== 'owner') {
				result.skipped.push({ did, reason: `owner_did cannot hold the ${role} role` });
				continue;
			}
			if (row) {
				if (row.role === 'owner' && row.status === 'active') result.unchanged.push(did);
				else {
					result.skipped.push({
						did,
						reason: `the owner's row is ${row.role}/${row.status} and is immutable`
					});
				}
				continue;
			}
		} else if (row && row.role === role && row.status === 'active') {
			result.unchanged.push(did);
			continue;
		}

		await db
			.prepare(
				`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'active', ?, ?)
				 ON CONFLICT (group_id, did) DO UPDATE SET
					role_id = excluded.role_id, status = 'active', updated_at = excluded.updated_at`
			)
			.bind(crypto.randomUUID(), group.id, did, target, createdAtMs(record.createdAt) || now, now)
			.run();
		result.restored.push(did);
	}

	for (const did of rows.keys()) {
		if (!recorded.has(did)) result.orphans.push(did);
	}

	return result;
}

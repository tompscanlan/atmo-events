// Reading a group's roster and authz config back out of its members space, and
// repairing the D1 projection from it.
//
// The roster and the authz config (which roles a group has, and what each one
// may do) are records, and D1 holds a cache of them. The `memberships` rows are
// a projection that can be dropped and rebuilt. A DID with no `membership`
// record has no access even if a stale row says otherwise. A role's effective
// grant is the union of the two binding records (`effectivePermissions`), not a
// `role_permissions` SELECT, and that is what the write gate uses
// (`resolveActorPermissions`, loaded by `getCallerMembership`).
//
// The transport is the one `about-read.ts` uses: the group's own app-password
// session, own-repo reads inside the space, no DPoP credential and no sync
// engine. Every record read here is written by the group account itself.
// Reading a record a member wrote would need a space credential.
//
// Absent records read as absent, like `readGroupAbout`: a group with an empty
// members space still renders its roster from the cache instead of a 500. A read
// that fails throws, because "failed" read as "empty" would hand the roster and
// the gate to the rows.
// `rosterSource` tells a caller which of the two it got, so "the records are
// empty" is never rendered as "the group has no members".
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	isMembershipKey,
	parseGroupAccess,
	parseGroupBindings,
	parseGroupMembership,
	parseGroupRole,
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

/** A membership record as it came back, with the identity the host addresses it
 *  by. `rkey` is the member DID (see `members-record.ts`). */
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
	createdAt: string | null;
}

export interface GroupMembers {
	memberships: GroupMembershipRecord[];
	/** The roles this group declares. A create seeds three; a group with none
	 *  has no authz config in its space yet. */
	roles: GroupRoleRecord[];
	/** The four community actions, bound to roles. `null` when the space holds
	 *  no such record. */
	permissions: GroupBindingsFields | null;
	/** The two modality (event) actions: same shape, separate record. */
	eventPermissions: GroupBindingsFields | null;
	/** The members space's own read policy, as a record. `null` when the space
	 *  holds none. */
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

/** A group's roster and authz config as records. Every half reads an absent
 *  record as absent, and throws when a read fails (see the header).
 *
 *  The five reads go out together: they are independent, they share one
 *  cached session, and in sequence they would put five PDS round trips in
 *  front of the page. */
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
		// The collection is checked again here, as in `readGroupAbout`: a host
		// that ignored the parameter must not turn other records into
		// memberships.
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
		// A role outside this build's vocabulary is dropped: nothing could resolve
		// its grant, so the gate could not answer for it.
		if (!parsed) continue;
		roles.push({ id: parsed.id, uri: record.uri, createdAt: parsed.createdAt });
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

/**
 * The effective grant: the union of what every role the caller holds is bound
 * to, across both binding records.
 *
 * Reading only `permissions` would silently drop every event grant, leaving an
 * admin who may configure the group but may not create its events. There are
 * no deny rules, no precedence and no hierarchy: a permission is held if any
 * binding names it. A role with no binding contributes nothing, and so does an
 * absent record, so a group whose authz records were never written resolves to
 * the empty set rather than to a default.
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

/** Whether the space holds an authz config at all. An absent one is not "a
 *  group that grants nothing", it is a group whose config was never written,
 *  so a caller must be able to tell the two apart before failing anyone
 *  closed. */
export function hasAuthzRecords(members: GroupMembers): boolean {
	return members.roles.length > 0 && members.permissions !== null;
}

/**
 * The resolver: what `actorDid` may do in the group whose records these are.
 *
 * A pure function of the records, with no D1, no session and no request, so it
 * has the shape `(group DID, actor DID) -> permission set` and another app
 * could lift it out as a library. The group is identified by the records it is
 * given. Reading them, deciding what an unreadable space means, and the
 * fallback for a group with no config belong to the loader
 * (`getCallerMembership`), never to this function.
 */
export function resolveActorPermissions(
	members: GroupMembers,
	actorDid: string | null
): Set<GroupPermission> {
	return effectivePermissions(members, rolesForDid(members, actorDid));
}

/** The records the resolver needs for one caller: their own membership (the
 *  rkey is the member DID, so it is a `getRecord`, not a roster listing), both
 *  binding records, and the role list `hasAuthzRecords` checks. Four reads,
 *  run together.
 *
 *  Unlike `readGroupMembers`, this does not degrade: a reader error propagates.
 *  It feeds the gate, and a gate that read "unreachable" as "no records" would
 *  either fall back to the rows or silently grant nothing. Falling back to the
 *  rows is the privilege leak `hasAuthzRecords` exists to prevent, so an error
 *  here makes the gate fail closed. */
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
		if (role) roles.push({ id: role.id, uri: record.uri, createdAt: role.createdAt });
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

/** The roles a DID holds according to the records. Empty for an unknown DID,
 *  for an anonymous caller, and for a record that grants nothing. All three
 *  must mean "no access", never "some default". */
export function rolesForDid(members: GroupMembers, did: string | null): GroupRoleName[] {
	if (!did) return [];
	const found = members.memberships.find((record) => record.subject === did);
	return found ? found.roles : [];
}

/** The access rule as one predicate: a member DID with no `membership` record,
 *  or with one granting no role we know, has no access. */
export function hasRecordedAccess(members: GroupMembers, did: string | null): boolean {
	return rolesForDid(members, did).length > 0;
}

/** Whether the records can be used as the source at all. An empty members space
 *  is not "a group with no members", it is a group whose control plane has not
 *  been written yet. So a roster is only taken from records when there is at
 *  least one membership record in them. */
export function hasMemberRecords(members: GroupMembers): boolean {
	return members.memberships.length > 0;
}

/** The owner DID, taken from the record that grants the owner role.
 *
 *  A group with no row is rebuilt around this (`./rebuild.ts`): it cannot be
 *  reconstructed without an owner, and `groups_identity_immutable` makes a
 *  guessed one permanent. It lives here so the derivation and the records it
 *  reads stay in one file. `null` means refuse, never guess. */
export function ownerDidFromRecords(members: GroupMembers): string | null {
	const owner = members.memberships.find((record) => record.roles.includes('owner'));
	return owner ? owner.subject : null;
}

/** Most privileged first, which is `GROUP_ROLES` order, so a member holding two
 *  roles projects onto the stronger one. Permissions have no precedence (they
 *  add up), but a D1 row holds exactly one role, so the projection has to
 *  choose, and choosing the weaker one would silently demote. This app writes
 *  one role per member, so this only matters for a record another app wrote. */
function primaryRole(roles: readonly GroupRoleName[]): GroupRoleName | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? null;
}

function createdAtMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Owner first, then by join time, then by DID. This is the order `listMembers`
 *  gets from SQL (`is_owner DESC, created_at ASC`), so a roster rendered from
 *  records does not look different from one rendered from the cache. DID
 *  breaks the remaining tie because two records written in the same
 *  millisecond must still order deterministically. */
function byRosterOrder(a: RosterEntry, b: RosterEntry): number {
	const rank = (entry: RosterEntry) => (entry.role === 'owner' ? 0 : 1);
	return rank(a) - rank(b) || a.created_at - b.created_at || a.did.localeCompare(b.did);
}

/** The roster as records say it is. A record granting no known role is dropped
 *  rather than rendered role-less: it grants no access, so showing it as a
 *  member would contradict the gate. */
export function rosterFromRecords(members: GroupMembers): RosterEntry[] {
	const roster: RosterEntry[] = [];
	for (const record of members.memberships) {
		const role = primaryRole(record.roles);
		if (!role) continue;
		roster.push({
			did: record.subject,
			role,
			// Every membership record means access, and access means active. There
			// is no suspension: a grant is revoked by deleting its record (see
			// `members-record.ts`).
			status: 'active',
			created_at: createdAtMs(record.createdAt)
		});
	}
	return roster.sort(byRosterOrder);
}

/** The same shape from the cache, so a page renders one type either way. */
export function rosterFromRows(rows: MemberRow[]): RosterEntry[] {
	return rows.map((row) => ({
		did: row.did,
		role: row.role,
		status: row.status,
		created_at: row.created_at
	}));
}

export interface MembersRebuildResult {
	/** Rows inserted or corrected from a record. */
	restored: string[];
	/** Rows that already agreed with their record. */
	unchanged: string[];
	/** Roster rows with no membership record. Reported, never deleted: a grant
	 *  whose record write failed leaves this shape, and so does a revocation
	 *  whose row delete failed after its record was deleted. The gate already
	 *  denies both, so deleting them would only tidy the cache by guessing which
	 *  case each one is. */
	orphans: string[];
	/** Records that could not be projected, for example one naming a role this
	 *  group has no row for. The reason names the role so the fix is obvious. */
	skipped: { did: string; reason: string }[];
}

/**
 * Rebuild the `memberships` projection from the records. Used both over a
 * surviving row and, once `./rebuild.ts` has restored the row and its roles,
 * for a group that had none.
 *
 * Additive: it writes what the records say and touches nothing else, the same
 * contract `rebuildGroupCache` has for the profile columns. So if the cached
 * rows are dropped, a rebuild brings the roster back.
 *
 * The owner row is inserted, never updated. `memberships_owner_immutable`
 * refuses any change to the owner's role or status, and
 * `memberships_owner_role_reserved_*` reserves the owner role for
 * `groups.owner_did`. So a record that disagrees with the row is a conflict the
 * schema owns: it is skipped with a reason. A missing owner row is re-inserted,
 * which is the case that matters after a cache drop.
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
		// A subject that cannot be a record key cannot have been written by us,
		// and projecting it would put an unaddressable DID on the roster.
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

		// The schema decides the owner, so the record is checked against it rather
		// than applied over it (see `rebuildGroupMembers`). A record that
		// disagrees is reported, never reconciled. A missing owner row is still
		// inserted.
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

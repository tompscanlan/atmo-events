// Reading a group's ROSTER back out of its members space, and repairing the D1
// projection from it.
//
// This is the half that makes the write worth anything: after T014 the roster
// is not app data with a record copy, it is RECORDS with a D1 cache. The
// direction of truth is what changed — `memberships` rows are now a projection
// that can be dropped and rebuilt (`data-model.md`), and a DID with no
// `membership` record has no access even if a stale row says otherwise.
//
// The transport is the one `about-read.ts` already proved (FR-007): the group's
// OWN app-password session, own-repo reads inside the space, no DPoP credential
// and no sync engine. Reading a MEMBER-authored record would need a space
// credential and that is iteration 2 (`om-kp7ss.5`) — every record read here is
// authority-authored, which is exactly why iteration 1 is cheap.
//
// DEGRADES RATHER THAN THROWS, like `readGroupAbout`: a group provisioned
// before this code existed has an empty members space, and its roster page must
// still render from the cache instead of 500ing. `rosterSource` is how a caller
// knows which of the two it got, so "the records are empty" can never be
// silently rendered as "the group has no members".
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	isMembershipKey,
	parseGroupAccess,
	parseGroupMembership,
	type GroupAccessFields
} from '../members-record';
import { GROUP_ROLES, type GroupRoleName } from '../permissions';
import type { GroupRow, MemberRow, RosterEntry } from '../types';
import type { GroupSpaceReader } from './about-read';
import { ensureGroupsSchema } from './schema';

/** A membership record as it came back, with the identity the host addresses it
 *  by. `rkey` IS the member DID — see `members-record.ts`. */
export interface GroupMembershipRecord {
	uri: string;
	rkey: string;
	subject: string;
	roles: GroupRoleName[];
	createdAt: string | null;
}

export interface GroupMembers {
	memberships: GroupMembershipRecord[];
	/** The members space's own read policy, as a record. `null` when the space
	 *  holds none — which a group created before T014 will not. */
	access: GroupAccessFields | null;
}

export const NO_MEMBER_RECORDS: GroupMembers = { memberships: [], access: null };

/** Records first, then the cache — a page says which one it rendered. */
export type RosterSource = 'records' | 'cache';

/** A group's roster as records. Both halves degrade to absent rather than
 *  throwing (see the header). */
export async function readGroupMembers(
	reader: GroupSpaceReader,
	group: GroupRow
): Promise<GroupMembers> {
	const space = group.members_space_uri;
	if (!space) return NO_MEMBER_RECORDS;
	const repo = group.group_did;

	const accessRecord = await reader.get({
		space,
		repo,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY
	});

	const memberships: GroupMembershipRecord[] = [];
	for (const record of await reader.list({
		space,
		repo,
		collection: GROUP_MEMBERSHIP_COLLECTION
	})) {
		// The collection filter is re-applied client-side for the reason
		// `readGroupAbout` re-applies it: the parameter is measured to work, and a
		// host that ignored it must not turn into memberships that are not
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

	return {
		memberships,
		access: accessRecord ? parseGroupAccess(accessRecord.value) : null
	};
}

/** The roles a DID holds according to the records. Empty for an unknown DID,
 *  for an anonymous caller, and for a record that grants nothing — the three
 *  cases that must all mean "no access" rather than "some default". */
export function rolesForDid(members: GroupMembers, did: string | null): GroupRoleName[] {
	if (!did) return [];
	const found = members.memberships.find((record) => record.subject === did);
	return found ? found.roles : [];
}

/** FR-006's access rule, as one predicate: a member DID with no `membership`
 *  record — or one granting no role we know — has no access. */
export function hasRecordedAccess(members: GroupMembers, did: string | null): boolean {
	return rolesForDid(members, did).length > 0;
}

/** Whether the records can be used as the source at all. An empty members space
 *  is not "a group with no members", it is a group whose control plane has not
 *  been written yet, and the two must not be confused — so a roster is only
 *  taken from records when there is at least one membership record in them. */
export function hasMemberRecords(members: GroupMembers): boolean {
	return members.memberships.length > 0;
}

/** The owner DID, derived from the record that grants the owner role.
 *
 *  This is the value the COLD rebuild is missing (`om-z5ady` / T017a): a group
 *  with no row cannot be reconstructed without an owner, and
 *  `groups_identity_immutable` makes a guessed one permanent. It lives here
 *  rather than there so the derivation and the records it reads stay in one
 *  file; `null` means refuse, never guess. */
export function ownerDidFromRecords(members: GroupMembers): string | null {
	const owner = members.memberships.find((record) => record.roles.includes('owner'));
	return owner ? owner.subject : null;
}

/** Most privileged first, which is `GROUP_ROLES` order, so a member holding two
 *  roles projects onto the stronger one. The union model has no precedence for
 *  PERMISSIONS — they add up — but a D1 row holds exactly one role, so the
 *  projection has to choose, and choosing the weaker one would silently demote.
 *  (Iteration 1 writes one role per member, so this only bites a record another
 *  app wrote.) */
function primaryRole(roles: readonly GroupRoleName[]): GroupRoleName | null {
	return GROUP_ROLES.find((role) => roles.includes(role)) ?? null;
}

function createdAtMs(value: string | null): number {
	const parsed = value ? Date.parse(value) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : 0;
}

/** Owner first, then by join time, then by DID — the same order `listMembers`
 *  gets from SQL (`is_owner DESC, created_at ASC`), so a roster rendered from
 *  records is not visibly a different list from one rendered from the cache.
 *  DID breaks the remaining tie because two records written in the same
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
			// Every membership record means access, and access means active:
			// suspension deletes the record (see `members-record.ts`).
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
	/** Roster rows with NO membership record. Reported, never deleted: a
	 *  suspended member is exactly this shape by design, and so is a row whose
	 *  record write failed — deleting both to make the numbers agree would eject
	 *  people to tidy up a cache. */
	orphans: string[];
	/** A record naming a role this group has no row for, so nothing could be
	 *  projected. Names the role so the fix is obvious rather than mysterious. */
	skipped: { did: string; reason: string }[];
}

/**
 * REBUILD the `memberships` projection from the records (`data-model.md` mode 1
 * for the roster).
 *
 * Additive on purpose — it writes what the records say and touches nothing
 * else, which is the same contract `rebuildGroupCache` has for the profile
 * columns. What it therefore proves is SC-002's claim for the roster: drop the
 * cached rows, rebuild, and the roster comes back.
 *
 * THE OWNER ROW IS INSERTED, NEVER UPDATED. `memberships_owner_immutable`
 * refuses any UPDATE of the owner's row and `memberships_owner_role_reserved_*`
 * reserves the owner role for `groups.owner_did`, so a record disagreeing with
 * the row is a conflict the schema owns: it is skipped with a reason rather
 * than fought. A MISSING owner row is re-inserted, which is the case that
 * matters after a cache drop.
 */
export async function rebuildGroupMembers(
	db: D1Database,
	reader: GroupSpaceReader,
	group: GroupRow
): Promise<MembersRebuildResult> {
	await ensureGroupsSchema(db);
	const members = await readGroupMembers(reader, group);
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
	for (const row of existing.results ?? []) rows.set(row.did, { role: row.role, status: row.status });

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

		// THE OWNER IS DECIDED BY THE SCHEMA, so the record is checked against it
		// rather than applied over it. `groups.owner_did` pins who the owner is,
		// `memberships_owner_role_reserved_*` pins which role they hold, and
		// `memberships_owner_immutable` refuses every UPDATE of that row — so a
		// record that disagrees is reported, never reconciled. A MISSING owner row
		// is still inserted, which is the case a cache drop produces.
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
			.bind(
				crypto.randomUUID(),
				group.id,
				did,
				target,
				createdAtMs(record.createdAt) || now,
				now
			)
			.run();
		result.restored.push(did);
	}

	for (const did of rows.keys()) {
		if (!recorded.has(did)) result.orphans.push(did);
	}

	return result;
}

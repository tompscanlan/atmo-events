// Every D1 read and write the groups surface makes. The SQL invariants live in
// migrations/0001_groups.sql; this module is the only thing that speaks to
// those tables, and it never re-implements a rule the schema already enforces —
// it reports the constraint failure instead (see `constraintMessage`).
import {
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	isGroupPermission,
	resolvePermissions,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import type { CallerMembership, GroupRow, JoinRequestRow, MemberRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	hasAuthzRecords,
	readCallerAuthz,
	resolveActorPermissions
} from './members-read';
import { ensureGroupsSchema } from './schema';

export interface CreateGroupInput {
	/** The group's custodial DID. `runCreateGroup` mints it before this INSERT —
	 *  the mint is what reserves the name (FR-001a) — so by the time it gets
	 *  here it always already exists, and it is immutable afterwards
	 *  (`groups_identity_immutable`). */
	groupDid: string;
	ownerDid: string;
	name: string;
	/** No local name key: the mint's handle is the name reservation and the DID
	 *  is the URL key, so there is nothing local to reserve (FR-001a, FR-010a).
	 *  No `status` either: a group that exists is published (FR-016c). */
	description?: string | null;
	visibility?: GroupRow['visibility'];
	requireApproval?: boolean;
	locationName?: string | null;
	/** No `spaceUri`: spaces are PROVISIONED at create (`./spaces.ts`), never
	 *  supplied. The row is inserted with both URIs NULL and filled by
	 *  `recordGroupSpaces` once the PDS has confirmed them. The order is no
	 *  longer forced — the space key is `self`, so a space URI is a function of
	 *  the group DID alone — the INSERT simply goes first because a row is the
	 *  cheapest durable thing to waste. */
}

export interface UpdateGroupInput {
	name?: string;
	description?: string | null;
	/** No `status`: see `CreateGroupInput`. */
	visibility?: GroupRow['visibility'];
	requireApproval?: boolean;
	locationName?: string | null;
	/** Deliberately absent: a group's space URIs are derived from its own DID
	 *  and the decided space types, so there is nothing for a settings form to
	 *  edit. Letting one be typed in allowed a group to point at a space it does
	 *  not own. */
}

/** Thrown for a rule the SQL refused. `reason` is a stable machine tag so a
 *  route can map it to a status code without string matching. */
export class GroupRuleError extends Error {
	constructor(
		readonly reason: /** The group DID is already bound. The ONLY uniqueness failure a
			 *  create can now hit: the handle registration at mint adjudicates
			 *  the name, so there is no local reservation to collide with
			 *  (FR-001a). */
			| 'did-taken'
			| 'owner-protected'
			| 'owner-role-reserved'
			| 'not-found'
			| 'already-pending'
			/** A private group was asked to admit someone who was not invited.
			 *  Raised by `requestJoin`, not by the schema: the schema forbids the
			 *  open-join CONFIGURATION (0003), this forbids the ACT. */
			| 'invite-only'
			/** The settings or create form tried to leave a private group
			 *  open-join. The 0003 triggers refuse; this is their tag. */
			| 'private-needs-approval'
			| 'constraint',
		message: string
	) {
		super(message);
		this.name = 'GroupRuleError';
	}
}

/** Maps a refusal from the schema onto the tags above. The schema is the
 *  authority on these rules, so the app reads its refusals rather than
 *  duplicating the checks and hoping the two stay in step.
 *
 *  SQLite names the COLUMNS of a violated unique index, never the index — so
 *  the pending-request index shows up as `join_requests.group_id,
 *  join_requests.did`. D1 wraps the same text ("D1_ERROR: UNIQUE constraint
 *  failed: groups.group_did: SQLITE_CONSTRAINT"), which is why matching is on the
 *  column names and on the triggers' own RAISE messages. */
function constraintMessage(e: unknown): GroupRuleError | null {
	const text = e instanceof Error ? e.message : String(e);
	// Trigger messages first: they are the specific diagnosis, and a trigger can
	// fire on a statement that would also trip a unique index.
	if (/owner role is reserved/.test(text)) {
		return new GroupRuleError('owner-role-reserved', 'The owner role is reserved for the owner');
	}
	if (/private group must require approval/.test(text)) {
		return new GroupRuleError(
			'private-needs-approval',
			'A private group must require approval to join — invite members instead'
		);
	}
	if (/owner cannot be|owner role cannot be|owner must hold|are immutable/.test(text)) {
		return new GroupRuleError('owner-protected', 'The group owner cannot be changed');
	}
	if (/UNIQUE constraint failed/.test(text)) {
		if (/groups\.group_did/.test(text)) {
			return new GroupRuleError('did-taken', 'That DID is already bound to another group');
		}
		if (/join_requests\.(group_id|did)/.test(text)) {
			return new GroupRuleError('already-pending', 'A join request is already pending');
		}
		if (/memberships\.(group_id|did)/.test(text)) {
			return new GroupRuleError('constraint', 'That DID is already on the roster');
		}
	}
	if (/SQLITE_CONSTRAINT|constraint failed|FOREIGN KEY/i.test(text)) {
		return new GroupRuleError('constraint', 'That change is not allowed');
	}
	return null;
}

async function guard<T>(work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		const mapped = constraintMessage(e);
		if (mapped) throw mapped;
		throw e;
	}
}

const GROUP_COLUMNS = `id, group_did, owner_did, name, description, visibility,
	require_approval, image_cid, image_mime, image_size, location_name, about_space_uri,
	members_space_uri, created_at, updated_at`;

/** Creates the group, seeds the five legacy roles with their default bundles,
 *  and installs exactly one ACTIVE OWNER membership — as a single D1 batch,
 *  which D1 runs in one transaction, so a group can never exist without its
 *  roles or without its owner.
 *
 *  The owner ROLE is not inserted here: the `groups_seed_owner_role` trigger
 *  creates it as part of the group's own INSERT (that is how "at least one
 *  owner role" becomes a schema guarantee rather than a convention). The role
 *  inserts below therefore use ON CONFLICT DO NOTHING for that row, and every
 *  dependent insert resolves the role by (group_id, name) in SQL so nothing
 *  needs to read back a generated id mid-transaction. */
export async function createGroup(db: D1Database, input: CreateGroupInput): Promise<GroupRow> {
	await ensureGroupsSchema(db);
	const groupId = crypto.randomUUID();

	await guard(() => db.batch(createGroupStatements(db, input, groupId, Date.now())));

	const row = await getGroupById(db, groupId);
	if (!row) throw new GroupRuleError('not-found', 'Group vanished immediately after creation');
	return row;
}

/** The DID a rehearsal inserts under. `.invalid` is reserved (RFC 2606), so no
 *  minted DID can collide with it, and the row never commits anyway. */
const REHEARSAL_DID = 'did:web:create-rehearsal.invalid';
/** The rehearsal's two verdicts. They travel inside an error message because
 *  an error is the only thing that makes D1 roll a batch back. */
const REHEARSAL_LANDED = 'rehearsal-landed';
const REHEARSAL_NO_OWNER = 'rehearsal-no-owner';

/** RUNS `createGroup`'s batch and forces it to roll back, so a create can find
 *  out the tables would refuse its row BEFORE a did:plc exists.
 *
 *  WHY A REHEARSAL AND NOT A CHECK. Two things have refused a create's INSERT
 *  after the mint, and neither can be seen by a check written here: schema
 *  drift (`ensureGroupsSchema` is IF NOT EXISTS throughout, so a changed table
 *  keeps its old shape — a leftover `slug NOT NULL` refused every create on
 *  2026-09-22), and the 0003 trigger that refuses a private open-join group.
 *  Re-checking the second in TypeScript would break this module's rule that the
 *  schema is the authority. The first cannot be enumerated at all. Running the
 *  real statements asks the one thing that knows.
 *
 *  HOW IT ROLLS BACK. D1 has no BEGIN/ROLLBACK. A batch is a transaction that
 *  commits unless a statement fails, so the batch ends in a statement that
 *  ALWAYS fails, and its error carries the verdict. `json_extract` with an
 *  invalid path raises an error that quotes the path, and the path says whether
 *  the owner membership (the last row the batch writes) landed. "Landed" is
 *  positive evidence: no error at all proves nothing. A statement earlier in
 *  the batch that fails raises its own error first, and that is the refusal
 *  the real create would have met.
 *
 *  Resolves when the row would land. Throws the mapped `GroupRuleError` for a
 *  named rule the schema enforces, and anything else as it came. */
export async function rehearseCreateGroup(
	db: D1Database,
	input: Omit<CreateGroupInput, 'groupDid'>
): Promise<void> {
	await ensureGroupsSchema(db);
	const groupId = crypto.randomUUID();
	const statements = createGroupStatements(
		db,
		{ ...input, groupDid: REHEARSAL_DID },
		groupId,
		Date.now()
	);
	statements.push(
		db
			.prepare(
				`SELECT json_extract('{}', CASE WHEN EXISTS (
					SELECT 1 FROM memberships m JOIN roles r ON r.id = m.role_id
					WHERE m.group_id = ? AND m.did = ? AND r.is_owner = 1 AND m.status = 'active'
				) THEN '${REHEARSAL_LANDED}' ELSE '${REHEARSAL_NO_OWNER}' END)`
			)
			.bind(groupId, input.ownerDid)
	);

	try {
		await db.batch(statements);
	} catch (e) {
		const text = e instanceof Error ? e.message : String(e);
		if (text.includes(REHEARSAL_LANDED)) return;
		if (text.includes(REHEARSAL_NO_OWNER)) {
			throw new Error('the group row was accepted but its owner membership was not', {
				cause: e
			});
		}
		// A named rule is mapped as `guard` would. A bare `constraint` is not: it
		// names no rule the app knows, and the raw text names the column.
		const mapped = constraintMessage(e);
		throw mapped && mapped.reason !== 'constraint' ? mapped : e;
	}
	// Unreachable while the last statement always raises; if it ever does not,
	// the probe rows just committed and nobody should be told the table is fine.
	throw new Error('the create rehearsal committed instead of rolling back');
}

/** `createGroup`'s one batch, shared with `rehearseCreateGroup` so the
 *  rehearsal can never test a different write from the one it vouches for. */
function createGroupStatements(
	db: D1Database,
	input: CreateGroupInput,
	groupId: string,
	now: number
): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO groups (id, group_did, owner_did, name, description,
					visibility, require_approval, location_name, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				groupId,
				input.groupDid,
				input.ownerDid,
				input.name,
				input.description ?? null,
				input.visibility ?? 'public',
				input.requireApproval === false ? 0 : 1,
				input.locationName ?? null,
				now,
				now
			)
	];

	for (const role of GROUP_ROLES) {
		if (role !== 'owner') {
			statements.push(
				db
					.prepare(
						`INSERT INTO roles (id, group_id, name, is_owner) VALUES (?, ?, ?, 0)
						 ON CONFLICT (group_id, name) DO NOTHING`
					)
					.bind(crypto.randomUUID(), groupId, role)
			);
		}
		statements.push(
			db
				.prepare(
					`INSERT INTO role_permissions (role_id, permission)
					 SELECT r.id, j.value FROM roles r, json_each(?) j
					 WHERE r.group_id = ? AND r.name = ?
					 ON CONFLICT DO NOTHING`
				)
				.bind(JSON.stringify(DEFAULT_ROLE_PERMISSIONS[role]), groupId, role)
		);
	}

	statements.push(
		db
			.prepare(
				`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
				 SELECT ?, ?, ?, r.id, 'active', ?, ? FROM roles r
				 WHERE r.group_id = ? AND r.is_owner = 1`
			)
			.bind(crypto.randomUUID(), groupId, input.ownerDid, now, now, groupId)
	);

	return statements;
}

export async function getGroupById(db: D1Database, id: string): Promise<GroupRow | null> {
	await ensureGroupsSchema(db);
	return db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).bind(id).first<GroupRow>();
}

/** The group a DID names. THE route lookup: every group URL carries the DID,
 *  and a handle URL is resolved to one before it gets here (FR-010a). There is
 *  no by-name lookup to pair with it — `groups` holds no name key at all, and a
 *  handle is the identity resolver's answer rather than a column we could
 *  query. */
export async function getGroupByDid(db: D1Database, groupDid: string): Promise<GroupRow | null> {
	await ensureGroupsSchema(db);
	return db
		.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE group_did = ?`)
		.bind(groupDid)
		.first<GroupRow>();
}

/** Browse listing. Anonymous callers see PUBLIC groups only; `private` is
 *  invisible unless the caller is on the roster. A signed-in caller
 *  additionally sees every group they own or are an active member of — which is
 *  the whole of what "their groups" means now that there is no publication
 *  state to hide a group from its own creator (FR-016c).
 *
 *  This is the one place a page may render `name`/`description` from the row
 *  rather than from records, and the reason is structural rather than a
 *  concession: the about space is never anonymously readable, so no indexer can
 *  read a group's name for us, and a records-first list would be N sessions × N
 *  space reads. (Spec: FR-010, the one bounded exception.) */
export async function listGroups(
	db: D1Database,
	opts: { callerDid?: string | null; limit?: number } = {}
): Promise<GroupRow[]> {
	await ensureGroupsSchema(db);
	const caller = opts.callerDid ?? null;
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
	const { results } = await db
		.prepare(
			`SELECT ${GROUP_COLUMNS} FROM groups
			 WHERE visibility = 'public'
			    OR (? IS NOT NULL AND owner_did = ?)
			    OR (? IS NOT NULL AND id IN (
			          SELECT group_id FROM memberships WHERE did = ? AND status = 'active'))
			 ORDER BY created_at DESC
			 LIMIT ?`
		)
		.bind(caller, caller, caller, caller, limit)
		.all<GroupRow>();
	return results ?? [];
}

export async function updateGroup(
	db: D1Database,
	groupId: string,
	input: UpdateGroupInput
): Promise<void> {
	await ensureGroupsSchema(db);
	const sets: string[] = [];
	const values: unknown[] = [];
	const push = (column: string, value: unknown) => {
		sets.push(`${column} = ?`);
		values.push(value);
	};
	if (input.name !== undefined) push('name', input.name);
	if (input.description !== undefined) push('description', input.description);
	if (input.visibility !== undefined) push('visibility', input.visibility);
	if (input.requireApproval !== undefined) push('require_approval', input.requireApproval ? 1 : 0);
	if (input.locationName !== undefined) push('location_name', input.locationName);
	if (sets.length === 0) return;
	push('updated_at', Date.now());
	values.push(groupId);
	await guard(() =>
		db
			.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
			.bind(...values)
			.run()
	);
}

/** Records the two space URIs a successful provisioning returned.
 *
 *  Separate from `updateGroup` on purpose: this is the only writer of these
 *  columns, it is not user input, and keeping it out of the settings path is
 *  what makes "a group's space URIs are not editable" true rather than merely
 *  intended. Writes both or neither, so a group is never half-provisioned in
 *  D1 even if it is on the PDS. */
export async function recordGroupSpaces(
	db: D1Database,
	groupId: string,
	uris: { aboutSpaceUri: string; membersSpaceUri: string }
): Promise<void> {
	await ensureGroupsSchema(db);
	await guard(() =>
		db
			.prepare(
				`UPDATE groups SET about_space_uri = ?, members_space_uri = ?, updated_at = ?
				 WHERE id = ?`
			)
			.bind(uris.aboutSpaceUri, uris.membersSpaceUri, Date.now(), groupId)
			.run()
	);
}

/** Overwrites the columns a `profile` record OWNS, from that record.
 *
 *  Separate from `updateGroup` for the same reason `recordGroupSpaces` is: this
 *  is not user input. It is the cache-repair half of the rebuild
 *  (`data-model.md` mode 1), so it writes exactly the Tier-1 columns and
 *  nothing else — in particular it never touches `visibility`, `status` or
 *  `owner_did`, which no record owns and which a rebuild must not guess
 *  (Spec: FR-004b, FR-009).
 *
 *  `require_approval` goes through the same schema that refuses `private` with
 *  `require_approval = 0` (migrations/0003), so a profile claiming `open` on a
 *  private group is REFUSED here rather than quietly widening the group. That
 *  surfaces as `GroupRuleError('private-needs-approval')` via `guard`. */
export async function applyGroupCache(
	db: D1Database,
	groupId: string,
	cache: {
		name: string;
		description: string | null;
		require_approval: number;
		location_name: string | null;
	}
): Promise<void> {
	await ensureGroupsSchema(db);
	await guard(() =>
		db
			.prepare(
				`UPDATE groups SET name = ?, description = ?, require_approval = ?,
				        location_name = ?, updated_at = ?
				 WHERE id = ?`
			)
			.bind(
				cache.name,
				cache.description,
				cache.require_approval,
				cache.location_name,
				Date.now(),
				groupId
			)
			.run()
	);
}

/** The roster, owner first then by join time. Roles come back as names, not
 *  ids: a page never needs the id, and the name is what the role vocabulary is
 *  keyed by. */
export async function listMembers(db: D1Database, groupId: string): Promise<MemberRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(
			`SELECT m.id AS membership_id, m.did, r.name AS role, m.status, m.created_at
			 FROM memberships m JOIN roles r ON r.id = m.role_id
			 WHERE m.group_id = ?
			 ORDER BY r.is_owner DESC, m.created_at ASC`
		)
		.bind(groupId)
		.all<MemberRow>();
	return results ?? [];
}

/** One roster row, or null. The roster acts read it twice over: for the
 *  pre-check in front of a revocation or a role change, and for WHEN a member
 *  joined while their membership record does not exist yet
 *  (`server/roster.ts`). Loading the whole roster to answer either would grow
 *  with the group. */
export async function getMemberRow(
	db: D1Database,
	groupId: string,
	did: string
): Promise<MemberRow | null> {
	await ensureGroupsSchema(db);
	return db
		.prepare(
			`SELECT m.id AS membership_id, m.did, r.name AS role, m.status, m.created_at
			 FROM memberships m JOIN roles r ON r.id = m.role_id
			 WHERE m.group_id = ? AND m.did = ?`
		)
		.bind(groupId, did)
		.first<MemberRow>();
}

export async function listJoinRequests(
	db: D1Database,
	groupId: string,
	status: 'pending' | 'all' = 'pending'
): Promise<JoinRequestRow[]> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(
			`SELECT id, did, status, message, created_at FROM join_requests
			 WHERE group_id = ? AND (? = 'all' OR status = ?)
			 ORDER BY created_at ASC`
		)
		.bind(groupId, status, status)
		.all<JoinRequestRow>();
	return results ?? [];
}

/** What `did` is to `group`: roster row, pending request, and what it may do.
 *  Anonymous callers get an empty set, so a caller-less page asks `can()` the
 *  same way a signed-in one does.
 *
 *  THE PERMISSION SET IS THE RECORDS' (T016). This is the LOADER around the
 *  pure resolver (`resolveActorPermissions`): it owns the read, and the policy
 *  TS set 2026-09-22 (om-i92w3) for when the records cannot answer —
 *
 *    * NO CACHE. Every call reads the caller's membership and both binding
 *      records, so editing a record changes the NEXT decision with no D1 write
 *      and no deploy.
 *    * AN UNREADABLE SPACE FAILS CLOSED. A reader error propagates; no
 *      credential for a group that has a members space grants nothing. Neither
 *      falls back to the rows: "unreachable" read as "no config" is a leak.
 *    * NO CONFIG YET FALLS BACK. A space that is readable but holds no authz
 *      records — a group created before T013, or one with no members space at
 *      all — resolves from `role_permissions`, which is what those groups were
 *      created with. `hasAuthzRecords` is what tells the two apart.
 *
 *  NO ROW OVERRIDES A RECORD. A revocation deletes the record before the row
 *  (`roster.ts`), so a partial failure leaves a row with no record, which
 *  resolves to nothing — the pair errs toward less access by construction,
 *  with no deny rule here to keep in step. */
export async function getCallerMembership(
	db: D1Database,
	group: GroupRow,
	did: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	await ensureGroupsSchema(db);
	if (!did) {
		return { did: null, role: null, status: null, pendingRequestId: null, permissions: new Set() };
	}

	// `null` is a members space this deployment cannot read; no space at all is
	// a group with no config, which is the fallback case rather than this one.
	const records = !group.members_space_uri
		? NO_MEMBER_RECORDS
		: reader
			? readCallerAuthz(reader, group, did)
			: null;
	const [membership, pending, members] = await Promise.all([
		db
			.prepare(
				`SELECT r.name AS role, m.status FROM memberships m JOIN roles r ON r.id = m.role_id
				 WHERE m.group_id = ? AND m.did = ?`
			)
			.bind(group.id, did)
			.first<{ role: GroupRoleName; status: MemberRow['status'] }>(),
		db
			.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ? AND status = 'pending'`)
			.bind(group.id, did)
			.first<{ id: string }>(),
		records
	]);

	let permissions: ReadonlySet<GroupPermission>;
	if (!members) permissions = new Set();
	else if (!hasAuthzRecords(members)) permissions = await rowPermissions(db, group.id, did);
	else permissions = resolveActorPermissions(members, did);

	return {
		did,
		role: membership?.role ?? null,
		status: membership?.status ?? null,
		pendingRequestId: pending?.id ?? null,
		permissions
	};
}

/** The pre-T013 path: the union of the `role_permissions` rows an ACTIVE
 *  membership row reaches. Only `getCallerMembership` calls it, and only for a
 *  group whose space holds no authz config. */
async function rowPermissions(
	db: D1Database,
	groupId: string,
	did: string
): Promise<Set<GroupPermission>> {
	const grants = await db
		.prepare(
			`SELECT rp.permission FROM role_permissions rp
			 JOIN roles r ON r.id = rp.role_id
			 JOIN memberships m ON m.role_id = r.id AND m.group_id = r.group_id
			 WHERE m.group_id = ? AND m.did = ? AND m.status = 'active'`
		)
		.bind(groupId, did)
		.all<{ permission: string }>();
	return resolvePermissions([(grants.results ?? []).map((r) => r.permission)]);
}

/** Permissions a role grants, for the members page's role picker. */
export async function rolePermissions(
	db: D1Database,
	groupId: string
): Promise<Record<string, GroupPermission[]>> {
	await ensureGroupsSchema(db);
	const { results } = await db
		.prepare(
			`SELECT r.name AS role, rp.permission FROM roles r
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 WHERE r.group_id = ?
			 ORDER BY r.name`
		)
		.bind(groupId)
		.all<{ role: GroupRoleName; permission: string | null }>();
	const byRole: Record<string, GroupPermission[]> = {};
	for (const row of results ?? []) {
		const bucket = (byRole[row.role] ??= []);
		if (row.permission && isGroupPermission(row.permission)) bucket.push(row.permission);
	}
	return byRole;
}

/** Roster size, for a page that may show the count without being allowed the
 *  names (membership gates the list, not the fact that a group has members). */
export async function countActiveMembers(db: D1Database, groupId: string): Promise<number> {
	await ensureGroupsSchema(db);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE group_id = ? AND status = 'active'`)
		.bind(groupId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export type JoinOutcome = 'joined' | 'pending' | 'already-member' | 'already-pending';

/** Self-service join. With `require_approval` (the default) this records a
 *  PENDING request and no roster row — one row per fact, so a pending applicant
 *  is never briefly a member. Without it, the caller lands on the roster with
 *  the `member` role immediately.
 *
 *  A PRIVATE GROUP HAS NO SELF-SERVICE JOIN AT ALL (TS, 2026-09-17, om-5oxc8).
 *  Knocking is not a capability a private group offers: the address IS the
 *  group's DID, and the handle beside it is published to the PLC audit log at
 *  genesis, so "knows the address" is not evidence of anything, and answering a
 *  knock at all tells a stranger the group exists. The way in is an invite
 *  (om-a2n4t), which will call `addMember` on its own entry point
 *  rather than reopen this one. The refusal sits HERE, below the roster check,
 *  rather than in the form: every future caller of `requestJoin` inherits it,
 *  and an existing member's idempotent retry still answers `already-member`
 *  instead of erroring. */
export async function requestJoin(
	db: D1Database,
	group: GroupRow,
	did: string,
	message: string | null
): Promise<JoinOutcome> {
	await ensureGroupsSchema(db);
	const existing = await db
		.prepare(`SELECT status FROM memberships WHERE group_id = ? AND did = ?`)
		.bind(group.id, did)
		.first<{ status: string }>();
	if (existing) return 'already-member';

	if (group.visibility === 'private') {
		throw new GroupRuleError('invite-only', 'This group is invite-only');
	}

	if (group.require_approval) {
		try {
			const now = Date.now();
			await db
				.prepare(
					`INSERT INTO join_requests (id, group_id, did, status, message, created_at, updated_at)
					 VALUES (?, ?, ?, 'pending', ?, ?, ?)`
				)
				.bind(crypto.randomUUID(), group.id, did, message, now, now)
				.run();
			return 'pending';
		} catch (e) {
			const mapped = constraintMessage(e);
			if (mapped?.reason === 'already-pending') return 'already-pending';
			throw mapped ?? e;
		}
	}

	await addMember(db, group.id, did, 'member');
	return 'joined';
}

/** Puts `did` on the roster with `role`. Used by the no-approval join path and
 *  by approval; the owner role is unreachable through it because the schema
 *  reserves that role for `groups.owner_did`. */
export async function addMember(
	db: D1Database,
	groupId: string,
	did: string,
	role: Exclude<GroupRoleName, 'owner'>
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	await guard(() =>
		db
			.prepare(
				`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
				 SELECT ?, ?, ?, r.id, 'active', ?, ? FROM roles r
				 WHERE r.group_id = ? AND r.name = ?`
			)
			.bind(crypto.randomUUID(), groupId, did, now, now, groupId, role)
			.run()
	);
}

/** Approve: roster insert and request close in one batch, so an approved
 *  request always has a member behind it.
 *
 *  Returns the DID it admitted, because the caller needs it and this is the
 *  only place that knows it: the applicant is named by the REQUEST, not by the
 *  form, and the membership record the caller then writes is keyed by that DID
 *  (`server/members-writer.ts`). Re-reading the request afterwards would be a
 *  second query for a value this function already had in hand. */
export async function approveJoinRequest(
	db: D1Database,
	groupId: string,
	requestId: string,
	deciderDid: string,
	role: Exclude<GroupRoleName, 'owner'> = 'member'
): Promise<{ did: string }> {
	await ensureGroupsSchema(db);
	const request = await db
		.prepare(`SELECT did FROM join_requests WHERE id = ? AND group_id = ? AND status = 'pending'`)
		.bind(requestId, groupId)
		.first<{ did: string }>();
	if (!request) throw new GroupRuleError('not-found', 'No such pending join request');

	const now = Date.now();
	await guard(() =>
		db.batch([
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
					 SELECT ?, ?, ?, r.id, 'active', ?, ? FROM roles r
					 WHERE r.group_id = ? AND r.name = ?
					 ON CONFLICT (group_id, did) DO NOTHING`
				)
				.bind(crypto.randomUUID(), groupId, request.did, now, now, groupId, role),
			db
				.prepare(
					`UPDATE join_requests SET status = 'approved', decided_by_did = ?, decided_at = ?,
					   updated_at = ? WHERE id = ?`
				)
				.bind(deciderDid, now, now, requestId)
		])
	);
	return { did: request.did };
}

export async function decideJoinRequest(
	db: D1Database,
	groupId: string,
	requestId: string,
	deciderDid: string | null,
	status: 'rejected' | 'withdrawn'
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	const res = await db
		.prepare(
			`UPDATE join_requests SET status = ?, decided_by_did = ?, decided_at = ?, updated_at = ?
			 WHERE id = ? AND group_id = ? AND status = 'pending'`
		)
		.bind(status, deciderDid, now, now, requestId, groupId)
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'No such pending join request');
	}
}

/** Removes a roster row — the same DELETE whether an admin removed the member
 *  or the member left. The owner cannot be the subject: the
 *  `memberships_owner_undeletable` trigger refuses, which surfaces here as
 *  GroupRuleError('owner-protected'). */
export async function removeMember(db: D1Database, groupId: string, did: string): Promise<void> {
	await ensureGroupsSchema(db);
	const res = await guard(() =>
		db.prepare(`DELETE FROM memberships WHERE group_id = ? AND did = ?`).bind(groupId, did).run()
	);
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'That DID is not on the roster');
	}
}

export async function changeMemberRole(
	db: D1Database,
	groupId: string,
	did: string,
	role: Exclude<GroupRoleName, 'owner'>
): Promise<void> {
	await ensureGroupsSchema(db);
	const res = await guard(() =>
		db
			.prepare(
				`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE group_id = ? AND name = ?),
				   updated_at = ?
				 WHERE group_id = ? AND did = ?`
			)
			.bind(groupId, role, Date.now(), groupId, did)
			.run()
	);
	if ((res.meta?.changes ?? 0) === 0) {
		throw new GroupRuleError('not-found', 'That DID is not on the roster');
	}
}

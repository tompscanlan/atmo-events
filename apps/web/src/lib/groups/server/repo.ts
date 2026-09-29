// Every D1 read and write the groups feature makes. The schema in
// migrations/0001_groups.sql enforces the invariants, and this module reports
// its refusals (`constraintMessage`) instead of checking them again.
import {
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	isGroupPermission,
	resolvePermissions,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import type {
	CallerMembership,
	GroupRow,
	GroupVisibility,
	JoinRequestRow,
	MemberRow
} from '../types';
import type { GroupSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	hasAuthzRecords,
	hasRecordedAccess,
	readCallerAuthz,
	resolveActorPermissions
} from './members-read';
import { ensureGroupsSchema } from './schema';

/** A new group's row. Visibility is not here: it is the about space's read
 *  policy. The space URIs start NULL and `recordGroupSpaces` fills them. */
export interface CreateGroupInput {
	/** Minted before this INSERT. The mint reserves the name. */
	groupDid: string;
	ownerDid: string;
	name: string;
	description?: string | null;
	requireApproval?: boolean;
	locationName?: string | null;
}

/** What a settings save may change. Visibility is a host write
 *  (`setAboutSpaceReadPolicy`). Space URIs are not accepted, because one could
 *  point a group at a space it does not own. */
export interface UpdateGroupInput {
	name?: string;
	description?: string | null;
	requireApproval?: boolean;
	locationName?: string | null;
}

/** Thrown for a rule the SQL refused. `reason` is a stable machine tag, so a
 *  route can map it to a status code without string matching. */
export class GroupRuleError extends Error {
	constructor(
		readonly reason: /** The group DID is already bound. This is the only uniqueness
			 *  failure a create can hit, since the handle reserves the name. */
			| 'did-taken'
			| 'owner-protected'
			| 'owner-role-reserved'
			| 'not-found'
			| 'already-pending'
			/** A stranger asked to join a group its host reads as private. */
			| 'invite-only'
			| 'constraint',
		message: string
	) {
		super(message);
		this.name = 'GroupRuleError';
	}
}

/** Maps a schema refusal onto the tags above, so the app never duplicates the
 *  schema's checks. SQLite names the columns of a violated unique index, not
 *  the index, and D1 wraps the same text, so matching is on column names and
 *  on the triggers' RAISE messages. */
function constraintMessage(e: unknown): GroupRuleError | null {
	const text = e instanceof Error ? e.message : String(e);
	// Triggers first: one statement can fire a trigger and trip a unique index.
	if (/owner role is reserved/.test(text)) {
		return new GroupRuleError('owner-role-reserved', 'The owner role is reserved for the owner');
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

const GROUP_COLUMNS = `id, group_did, owner_did, name, description, require_approval,
	image_cid, image_mime, image_size, location_name, about_space_uri, members_space_uri,
	created_at, updated_at`;

/** Creates the group, its three roles with their default bundles, and one
 *  active owner membership. D1 runs a batch as one transaction, so a group
 *  never exists without its roles or its owner. The owner role itself comes
 *  from the `groups_seed_owner_role` trigger. */
export async function createGroup(db: D1Database, input: CreateGroupInput): Promise<GroupRow> {
	await ensureGroupsSchema(db);
	const groupId = crypto.randomUUID();

	await guard(() => db.batch(createGroupStatements(db, input, groupId, Date.now())));

	const row = await getGroupById(db, groupId);
	if (!row) throw new GroupRuleError('not-found', 'Group vanished immediately after creation');
	return row;
}

/** `.invalid` is reserved (RFC 2606), so no minted DID can collide with it. */
const REHEARSAL_DID = 'did:web:create-rehearsal.invalid';
const REHEARSAL_LANDED = 'rehearsal-landed';
const REHEARSAL_NO_OWNER = 'rehearsal-no-owner';

/** Runs `createGroup`'s batch and forces a rollback, so a create learns that
 *  the tables would refuse its row before a did:plc exists. Only the real
 *  statements catch schema drift: `ensureGroupsSchema` uses IF NOT EXISTS, so
 *  a changed table keeps its old shape.
 *
 *  D1 has no BEGIN/ROLLBACK, and a batch commits unless a statement fails. So
 *  the batch ends in a `json_extract` whose invalid path always fails, and the
 *  path in the error says whether the owner membership landed. An earlier
 *  failure surfaces first, as the refusal the real create would meet.
 *
 *  Throws the mapped `GroupRuleError` for a named schema rule, and anything
 *  else as it came. */
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
		// A bare `constraint` names no rule, and the raw text names the column.
		const mapped = constraintMessage(e);
		throw mapped && mapped.reason !== 'constraint' ? mapped : e;
	}
	// Unreachable while the last statement always fails.
	throw new Error('the create rehearsal committed instead of rolling back');
}

/** A group's row, roles and owner membership. A create fills it from the form,
 *  and a cold rebuild fills it from records. */
interface GroupSeed {
	groupId: string;
	groupDid: string;
	ownerDid: string;
	name: string;
	description: string | null;
	requireApproval: boolean;
	locationName: string | null;
	aboutSpaceUri: string | null;
	membersSpaceUri: string | null;
	createdAt: number;
	updatedAt: number;
	/** An `owner` entry adds only its bundle: a trigger creates the owner role. */
	roles: readonly { name: GroupRoleName; permissions: readonly GroupPermission[] }[];
	ownerJoinedAt: number;
}

/** `createGroup`'s one batch, shared with `rehearseCreateGroup` so the
 *  rehearsal can never test a different write from the one it vouches for. */
function createGroupStatements(
	db: D1Database,
	input: CreateGroupInput,
	groupId: string,
	now: number
): D1PreparedStatement[] {
	return seedGroupStatements(db, {
		groupId,
		groupDid: input.groupDid,
		ownerDid: input.ownerDid,
		name: input.name,
		description: input.description ?? null,
		requireApproval: input.requireApproval !== false,
		locationName: input.locationName ?? null,
		aboutSpaceUri: null,
		membersSpaceUri: null,
		createdAt: now,
		updatedAt: now,
		roles: GROUP_ROLES.map((name) => ({ name, permissions: DEFAULT_ROLE_PERMISSIONS[name] })),
		ownerJoinedAt: now
	});
}

/** The statements behind both a create and a cold rebuild, so the two write
 *  the same shape. Each insert finds its role by (group_id, name) in SQL, so
 *  nothing reads back a generated id mid-transaction. */
function seedGroupStatements(db: D1Database, seed: GroupSeed): D1PreparedStatement[] {
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				`INSERT INTO groups (id, group_did, owner_did, name, description,
					require_approval, location_name, about_space_uri, members_space_uri,
					created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			)
			.bind(
				seed.groupId,
				seed.groupDid,
				seed.ownerDid,
				seed.name,
				seed.description,
				seed.requireApproval ? 1 : 0,
				seed.locationName,
				seed.aboutSpaceUri,
				seed.membersSpaceUri,
				seed.createdAt,
				seed.updatedAt
			)
	];

	for (const role of seed.roles) {
		if (role.name !== 'owner') {
			statements.push(
				db
					.prepare(
						`INSERT INTO roles (id, group_id, name, is_owner) VALUES (?, ?, ?, 0)
						 ON CONFLICT (group_id, name) DO NOTHING`
					)
					.bind(crypto.randomUUID(), seed.groupId, role.name)
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
				.bind(JSON.stringify(role.permissions), seed.groupId, role.name)
		);
	}

	statements.push(
		db
			.prepare(
				`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
				 SELECT ?, ?, ?, r.id, 'active', ?, ? FROM roles r
				 WHERE r.group_id = ? AND r.is_owner = 1`
			)
			.bind(
				crypto.randomUUID(),
				seed.groupId,
				seed.ownerDid,
				seed.ownerJoinedAt,
				seed.updatedAt,
				seed.groupId
			)
	);

	return statements;
}

/** What a cold rebuild restores. `server/rebuild.ts` decides it from records. */
export type RestoreGroupInput = Omit<GroupSeed, 'groupId' | 'updatedAt'>;

/** Inserts a group whose row was lost, in the same batch a create uses. A
 *  schema refusal comes back as the same `GroupRuleError`. */
export async function restoreGroup(db: D1Database, input: RestoreGroupInput): Promise<GroupRow> {
	await ensureGroupsSchema(db);
	const groupId = crypto.randomUUID();
	await guard(() =>
		db.batch(seedGroupStatements(db, { ...input, groupId, updatedAt: Date.now() }))
	);
	const row = await getGroupById(db, groupId);
	if (!row) throw new GroupRuleError('not-found', 'Group vanished immediately after its rebuild');
	return row;
}

export async function getGroupById(db: D1Database, id: string): Promise<GroupRow | null> {
	await ensureGroupsSchema(db);
	return db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).bind(id).first<GroupRow>();
}

/** The route lookup. A group URL carries the DID, or a handle resolved to one. */
export async function getGroupByDid(db: D1Database, groupDid: string): Promise<GroupRow | null> {
	await ensureGroupsSchema(db);
	return db
		.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE group_did = ?`)
		.bind(groupDid)
		.first<GroupRow>();
}

/** A group the declaration index lists, with the `createdAt` browse sorts by. */
export interface DeclaredGroup {
	did: string;
	createdAt: string | null;
}

/** One row of the browse list. `row` is null when this deployment holds no row
 *  for the group, which then renders without a link. `declared` says whether
 *  the declaration index listed it, so browse can show an undeclared group as
 *  private without asking its host. */
export interface BrowseEntry {
	group_did: string;
	row: GroupRow | null;
	declared: boolean;
}

/** Most membership-record checks one browse view runs at once. */
const ROSTER_CHECKS_IN_FLIGHT = 6;

/** The candidates `check` confirms, newest first, stopping at `wanted`. A
 *  check starts only while confirmed plus running is below `wanted`, so a
 *  rejection frees its slot for the next candidate. An unchecked candidate is
 *  never returned: listing it is the leak the check exists to close.
 *
 *  The first failure fails the listing. It is recorded, not left to the race,
 *  where a sibling that settles first would drop it. No check starts after a
 *  failure, and running checks are awaited before it is thrown. */
async function confirmNewest(
	candidates: GroupRow[],
	check: (row: GroupRow) => Promise<boolean>,
	wanted: number
): Promise<GroupRow[]> {
	const queue = [...candidates].sort((a, b) => b.created_at - a.created_at);
	const confirmed = new Set<GroupRow>();
	const running = new Set<Promise<void>>();
	// An array, not a nullable local: a callback sets it, which narrowing cannot see.
	const failures: unknown[] = [];
	let next = 0;
	for (;;) {
		while (
			failures.length === 0 &&
			next < queue.length &&
			running.size < ROSTER_CHECKS_IN_FLIGHT &&
			confirmed.size + running.size < wanted
		) {
			const row = queue[next++];
			const run: Promise<void> = check(row)
				.then(
					(ok) => {
						if (ok) confirmed.add(row);
					},
					(error: unknown) => {
						if (failures.length === 0) failures.push(error);
					}
				)
				.finally(() => running.delete(run));
			running.add(run);
		}
		if (running.size === 0) break;
		await Promise.race(running);
	}
	if (failures.length > 0) throw failures[0];
	return queue.filter((row) => confirmed.has(row));
}

/** Browse listing: the declaration index plus the caller's own groups.
 *
 *  A public group publishes a declaration and a private one withdraws it, so
 *  no visibility filter is needed. A declared group with no row here is still
 *  listed, because another app may have created it.
 *
 *  A signed-in caller also sees the groups they own or are an active member
 *  of, so a private group stays reachable by its members. A row can outlive
 *  its membership record, so an undeclared group the caller does not own is
 *  kept only when `onRoster` confirms them. `confirmNewest` bounds those
 *  checks, since anyone who may admit members can add a DID to many rosters.
 *
 *  Names and descriptions come from the row, not records: the about space is
 *  never anonymously readable, so no indexer can supply them. */
export async function listGroups(
	db: D1Database,
	opts: {
		callerDid?: string | null;
		declared: DeclaredGroup[];
		limit?: number;
		/** Whether the caller's membership record confirms them. When absent,
		 *  the membership row is trusted. */
		onRoster?: (row: GroupRow) => Promise<boolean>;
	}
): Promise<BrowseEntry[]> {
	await ensureGroupsSchema(db);
	const caller = opts.callerDid ?? null;
	const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

	const own = caller
		? ((
				await db
					.prepare(
						`SELECT ${GROUP_COLUMNS} FROM groups
						 WHERE owner_did = ?
						    OR id IN (SELECT group_id FROM memberships WHERE did = ? AND status = 'active')`
					)
					.bind(caller, caller)
					.all<GroupRow>()
			).results ?? [])
		: [];

	const byDid = new Map<string, GroupRow>();
	const dids = opts.declared.map((d) => d.did);
	if (dids.length > 0) {
		const { results } = await db
			.prepare(
				`SELECT ${GROUP_COLUMNS} FROM groups WHERE group_did IN (${dids.map(() => '?').join(', ')})`
			)
			.bind(...dids)
			.all<GroupRow>();
		for (const row of results ?? []) byDid.set(row.group_did, row);
	}

	const entries = new Map<string, BrowseEntry & { at: number }>();
	for (const d of opts.declared) {
		if (entries.has(d.did)) continue;
		const row = byDid.get(d.did) ?? null;
		entries.set(d.did, {
			group_did: d.did,
			row,
			declared: true,
			at: Date.parse(d.createdAt ?? '') || row?.created_at || 0
		});
	}

	const undeclared = own.filter((row) => !entries.has(row.group_did));
	const onRoster = opts.onRoster;
	const unchecked = undeclared.filter((row) => row.owner_did === caller || !onRoster);
	const confirmed = onRoster
		? await confirmNewest(
				undeclared.filter((row) => row.owner_did !== caller),
				onRoster,
				limit
			)
		: [];
	for (const row of [...unchecked, ...confirmed]) {
		entries.set(row.group_did, {
			group_did: row.group_did,
			row,
			declared: false,
			at: row.created_at
		});
	}

	return [...entries.values()]
		.sort((a, b) => b.at - a.at)
		.slice(0, limit)
		.map(({ group_did, row, declared }) => ({ group_did, row, declared }));
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

/** Records the two space URIs a provisioning returned. It is the only writer
 *  of these columns and takes no user input, which keeps them out of the
 *  settings path. It writes both or neither. */
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

/** Overwrites the columns a `profile` record owns, from that record, for the
 *  rebuild. It never touches `owner_did`, which no record owns.
 *  `require_approval` caches the profile's join policy even for a private
 *  group: its host's read policy is what makes it invite-only (`requestJoin`),
 *  and no stored value could keep up with a host any client can change. */
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

/** The roster, owner first, then by join time. Roles come back as names. */
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

/** One roster row, or null, so `roster.ts` can check one member without
 *  loading the whole roster. */
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

/** What `did` is to `group`: roster row, pending request, and permissions.
 *  An anonymous caller gets an empty set.
 *
 *  Permissions come from the records on every call, with no cache. A members
 *  space that cannot be read fails closed: a reader error propagates, and a
 *  space with no reader grants nothing, because reading "unreachable" as "no
 *  config" would leak access. A group with no authz records, or no members
 *  space, falls back to `role_permissions`.
 *
 *  No row overrides a record. A revocation deletes the record before the row,
 *  so a partial failure leaves less access. `onRoster` uses the same sources. */
export async function getCallerMembership(
	db: D1Database,
	group: GroupRow,
	did: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	await ensureGroupsSchema(db);
	if (!did) {
		return {
			did: null,
			role: null,
			status: null,
			pendingRequestId: null,
			permissions: new Set(),
			onRoster: false
		};
	}

	// `null` is a members space this deployment cannot read.
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
	let onRoster: boolean;
	if (!members) {
		permissions = new Set();
		onRoster = membership !== null;
	} else if (!hasAuthzRecords(members)) {
		permissions = await rowPermissions(db, group.id, did);
		onRoster = membership !== null;
	} else {
		permissions = resolveActorPermissions(members, did);
		onRoster = hasRecordedAccess(members, did);
	}

	return {
		did,
		role: membership?.role ?? null,
		status: membership?.status ?? null,
		pendingRequestId: pending?.id ?? null,
		permissions,
		onRoster
	};
}

/** The fallback for a group with no authz records: the union of the
 *  `role_permissions` rows an active membership reaches. */
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

/** Roster size. A page may show the count to someone not allowed the names. */
export async function countActiveMembers(db: D1Database, groupId: string): Promise<number> {
	await ensureGroupsSchema(db);
	const row = await db
		.prepare(`SELECT COUNT(*) AS n FROM memberships WHERE group_id = ? AND status = 'active'`)
		.bind(groupId)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

export type JoinOutcome = 'joined' | 'pending' | 'already-member' | 'already-pending';

/** Self-service join. With `require_approval` this records a pending request
 *  and no roster row, so an applicant is never briefly a member. Without it,
 *  the caller joins at once as `member`.
 *
 *  A private group has no self-service join. Its DID and handle are public in
 *  the PLC audit log, so knowing them proves nothing, and answering a request
 *  tells a stranger the group exists. Members are added with `addMember`. The
 *  refusal comes after the roster check, so a member's retry still answers
 *  `already-member`.
 *
 *  `visibility` is the host's answer (`readGroupVisibility`). Only `public`
 *  takes a join. `null` means the host was not asked, and it is refused. */
export async function requestJoin(
	db: D1Database,
	group: GroupRow,
	did: string,
	message: string | null,
	visibility: GroupVisibility | null
): Promise<JoinOutcome> {
	await ensureGroupsSchema(db);
	const existing = await db
		.prepare(`SELECT status FROM memberships WHERE group_id = ? AND did = ?`)
		.bind(group.id, did)
		.first<{ status: string }>();
	if (existing) return 'already-member';

	if (visibility !== 'public') {
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

/** Puts `did` on the roster with `role`, for an open join or a direct add. A
 *  DID already on the roster is refused as `GroupRuleError('constraint')`. A
 *  pending request from `did` is closed as approved in the same batch, by
 *  `decidedBy` (null for an open join), so it does not stay in the queue for a
 *  member. */
export async function addMember(
	db: D1Database,
	groupId: string,
	did: string,
	role: Exclude<GroupRoleName, 'owner'>,
	decidedBy: string | null = null
): Promise<void> {
	await ensureGroupsSchema(db);
	const now = Date.now();
	await guard(() =>
		db.batch([
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
					 SELECT ?, ?, ?, r.id, 'active', ?, ? FROM roles r
					 WHERE r.group_id = ? AND r.name = ?`
				)
				.bind(crypto.randomUUID(), groupId, did, now, now, groupId, role),
			db
				.prepare(
					`UPDATE join_requests SET status = 'approved', decided_by_did = ?, decided_at = ?,
					   updated_at = ?
					 WHERE group_id = ? AND did = ? AND status = 'pending'`
				)
				.bind(decidedBy, now, now, groupId, did)
		])
	);
}

/** Approve: roster insert and request close in one batch, so an approved
 *  request always has a member behind it. A request from a DID already on the
 *  roster fails the insert, which rolls back the close, as
 *  `GroupRuleError('constraint')`. Returns the admitted DID, which the request
 *  names and the caller's membership record is keyed by. */
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
					 WHERE r.group_id = ? AND r.name = ?`
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

/** Removes a roster row, for a leave or an eject. A trigger refuses the owner,
 *  as `GroupRuleError('owner-protected')`. */
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

// The D1 rows for a group itself: its row, its roles and their bundles. The
// schema in migrations/0001_groups.sql enforces the invariants, and a refusal
// comes back as `GroupRuleError` (./rules.ts).
import {
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	isGroupPermission,
	type GroupPermission,
	type GroupRoleName
} from '../../permissions';
import type { GroupRow } from '../../types';
import { ensureGroupsSchema } from '../schema';
import { errorText } from '../errors';
import { GroupRuleError, constraintMessage, guard } from './rules';

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

export const GROUP_COLUMNS = `id, group_did, owner_did, name, description, require_approval,
	location_name, about_space_uri, members_space_uri,
	created_at, updated_at`;

/** Creates the group, its three roles with their default bundles, and one
 *  owner membership. D1 runs a batch as one transaction, so a group
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
					WHERE m.group_id = ? AND m.did = ? AND r.is_owner = 1
				) THEN '${REHEARSAL_LANDED}' ELSE '${REHEARSAL_NO_OWNER}' END)`
			)
			.bind(groupId, input.ownerDid)
	);

	try {
		await db.batch(statements);
	} catch (e) {
		const text = errorText(e);
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
				`INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at)
				 SELECT ?, ?, ?, r.id, ?, ? FROM roles r
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

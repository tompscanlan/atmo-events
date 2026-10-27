// The D1 row for a group itself. A refusal comes back as `GroupRuleError` (./rules.ts).
import type { GroupRow } from '../../types';
import { ensureGroupsSchema } from '../schema';
import { GroupRuleError, guard } from './rules';

export interface CreateGroupInput {
	groupDid: string;
	/** Cached as an `admin` row in the same batch, as the host made them. */
	creatorDid: string;
	name: string;
	description?: string | null;
}

export const GROUP_COLUMNS = `id, group_did, name, description, about_space_uri,
	members_space_uri, created_at, updated_at`;

/** The space URIs start NULL and `recordGroupSpaces` fills them once the create is done. */
export async function createGroup(db: D1Database, input: CreateGroupInput): Promise<GroupRow> {
	await ensureGroupsSchema(db);
	const groupId = crypto.randomUUID();
	const now = Date.now();
	await guard(() =>
		db.batch([
			db
				.prepare(
					`INSERT INTO groups (id, group_did, name, description, created_at, updated_at)
					 VALUES (?, ?, ?, ?, ?, ?)`
				)
				.bind(groupId, input.groupDid, input.name, input.description ?? null, now, now),
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role, created_at, updated_at)
					 VALUES (?, ?, ?, 'admin', ?, ?)`
				)
				.bind(crypto.randomUUID(), groupId, input.creatorDid, now, now)
		])
	);
	const row = await getGroupById(db, groupId);
	if (!row) throw new GroupRuleError('not-found', 'Group vanished immediately after creation');
	return row;
}

export async function getGroupById(db: D1Database, id: string): Promise<GroupRow | null> {
	await ensureGroupsSchema(db);
	return db.prepare(`SELECT ${GROUP_COLUMNS} FROM groups WHERE id = ?`).bind(id).first<GroupRow>();
}

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
	input: { name: string; description: string | null }
): Promise<void> {
	await ensureGroupsSchema(db);
	await guard(() =>
		db
			.prepare(`UPDATE groups SET name = ?, description = ?, updated_at = ? WHERE id = ?`)
			.bind(input.name, input.description, Date.now(), groupId)
			.run()
	);
}

/** The only writer of the space columns, and it takes no user input. */
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

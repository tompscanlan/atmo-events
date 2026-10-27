// A group as the create leaves it in D1, through the app's own db helpers in the
// SQLite harness: its row, the creator's admin row, the roster rows a test names, and
// its space URIs. Nothing is written to any space.
import { groupSpaceUris, type GroupSpaceUris } from '../../ids';
import type { GroupRoleName } from '../../permissions';
import type { GroupRow } from '../../types';
import { createGroup, getGroupById, recordGroupSpaces, type CreateGroupInput } from '../db/groups';
import { addMember } from '../db/roster';
import { sqliteD1, type SqliteD1 } from './d1-sqlite';

export interface SeedGroupInput extends CreateGroupInput {
	/** Roster rows beyond the creator's, by DID, in the order they joined. */
	members?: Record<string, GroupRoleName>;
	/** Whether the about and members space URIs are recorded. On by default;
	 *  off for a group made before the spaces. */
	spaces?: boolean;
	/** The database to seed into, for a group beside one already there. A new
	 *  one by default. */
	harness?: SqliteD1;
}

export interface SeededGroup {
	harness: SqliteD1;
	db: D1Database;
	/** The row as D1 holds it once seeded. */
	group: GroupRow;
	/** The group's three space URIs. Only the about and members ones are kept
	 *  in D1, and only when `spaces` is on. */
	spaces: GroupSpaceUris;
}

export async function seedGroup(input: SeedGroupInput): Promise<SeededGroup> {
	const { members = {}, spaces = true, harness = sqliteD1(), ...create } = input;
	const created = await createGroup(harness.db, create);
	for (const [did, role] of Object.entries(members)) {
		await addMember(harness.db, created.id, did, role);
	}
	const uris = groupSpaceUris(create.groupDid);
	if (spaces) await recordGroupSpaces(harness.db, created.id, uris);
	const group = await getGroupById(harness.db, created.id);
	if (!group) throw new Error(`seed-group: ${create.groupDid} is not in D1 after seeding`);
	return { harness, db: harness.db, group, spaces: uris };
}

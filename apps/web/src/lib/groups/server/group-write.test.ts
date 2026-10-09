import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The write gate asks the group's records for the caller's standing once per
// request: every write a request makes passes the request's one reader, so a
// create or a settings save that writes nine records reads the standing once.
import { groupSpaceUris } from '../ids';
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { hostDown, spaceReader, type FakeSpaceReader } from './__fixtures__/space-reader';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { GroupPermissionError, requireGroupPermission } from './group-write';

import { createGroup, getGroupByDid, recordGroupSpaces } from './db/groups';
import { addMember } from './db/roster';
const GROUP_DID = 'did:plc:gatetestgroupaaaaaaaaaaa';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';

let harness: SqliteD1;
let group: GroupRow;

beforeEach(async () => {
	harness = sqliteD1();
	const created = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await recordGroupSpaces(harness.db, created.id, groupSpaceUris(GROUP_DID));
	await addMember(harness.db, created.id, MEMBER, 'member');
	group = (await getGroupByDid(harness.db, GROUP_DID))!;
});

afterEach(() => harness.close());

/** A host whose members space holds no records, so the rows decide, and whose
 *  call log counts the reads. `failFirst` fails the first read. */
function countingReader({ failFirst = false } = {}): FakeSpaceReader {
	const reader = spaceReader(GROUP_DID, {
		fail: (call) => (failFirst && reader.calls.length === 1 ? hostDown(502)(call) : undefined)
	});
	return reader;
}

const gate = (reader: GroupSpaceReader, callerDid: string) => ({
	db: harness.db,
	env: {},
	group,
	callerDid,
	reader
});

describe('requireGroupPermission', () => {
	it('reads the caller’s standing once for every write that shares a reader', async () => {
		const reader = countingReader();
		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		const once = reader.calls.length;
		expect(once).toBeGreaterThan(0);

		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		await requireGroupPermission(gate(reader, OWNER), 'CREATE_EVENT');
		expect(reader.calls.length).toBe(once);
	});

	it('reads again for another caller, or for another request’s reader', async () => {
		const reader = countingReader();
		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		const once = reader.calls.length;

		await expect(requireGroupPermission(gate(reader, MEMBER), 'MANAGE_GROUP')).rejects.toThrow(
			GroupPermissionError
		);
		expect(reader.calls.length).toBe(2 * once);

		const next = countingReader();
		await requireGroupPermission(gate(next, OWNER), 'MANAGE_GROUP');
		expect(next.calls.length).toBe(once);
	});

	it('does not keep a failed read, so the next write asks again', async () => {
		const reader = countingReader({ failFirst: true });
		await expect(requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP')).rejects.toThrow(
			/failed: 502/
		);
		await expect(
			requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP')
		).resolves.toBeUndefined();
	});
});

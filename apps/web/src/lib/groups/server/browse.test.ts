import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { createGroup } from './db/groups';
import { addMember } from './db/roster';
import { listGroups } from './browse';

const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

function group(name: string, groupDid: string) {
	return createGroup(db, { groupDid, creatorDid: OWNER, name });
}

const declared = (did: string, indexedAt: number) => ({ did, indexedAt });
const names = (entries: Awaited<ReturnType<typeof listGroups>>) =>
	entries.map((e) => e.row?.name ?? e.group_did);

describe('browse', () => {
	it('lists what the declaration index holds, with a row where this site has one', async () => {
		await group('Declared', 'did:plc:a');
		await group('Undeclared', 'did:plc:b');

		const entries = await listGroups(db, {
			callerDid: BOB,
			declared: [declared('did:plc:foreign', 2_000), declared('did:plc:a', 1_000)]
		});
		expect(entries).toEqual([
			{ group_did: 'did:plc:foreign', row: null, declared: true },
			{
				group_did: 'did:plc:a',
				row: expect.objectContaining({ name: 'Declared' }),
				declared: true
			}
		]);
	});

	it('adds the caller’s own undeclared groups, by their rows alone', async () => {
		const secret = await group('Secret', 'did:plc:d');
		await addMember(db, secret.id, ALICE, 'member');

		const own = (callerDid: string | null) => listGroups(db, { callerDid, declared: [] });
		expect(await own(ALICE)).toEqual([
			{ group_did: 'did:plc:d', row: expect.objectContaining({ name: 'Secret' }), declared: false }
		]);
		expect(names(await own(OWNER))).toEqual(['Secret']);
		expect(await own(BOB)).toEqual([]);
		expect(await own(null)).toEqual([]);
	});

	it('orders newest first, by indexing time or the row’s creation, and caps at the limit', async () => {
		const mine = await group('Mine', 'did:plc:mine');
		const at = mine.created_at;

		const entries = await listGroups(db, {
			callerDid: OWNER,
			limit: 3,
			declared: [
				declared('did:plc:old', at - 2_000),
				declared('did:plc:new', at + 2_000),
				declared('did:plc:mid', at - 1_000)
			]
		});
		expect(names(entries)).toEqual(['did:plc:new', 'Mine', 'did:plc:mid']);
	});
});

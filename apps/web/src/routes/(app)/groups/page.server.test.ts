import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What this route decides for /groups: that it reads no group's space and looks
// up no group's session (TS 2026-10-15), so the caller's rows alone list an
// undeclared group, and its page, which reads their standing with their own
// access, is what refuses a stale one. The listing rules are pinned in
// lib/groups/server/browse.test.ts; the index and the handle cache are stubbed
// here because neither decides anything about what is read.
vi.mock('$lib/groups/server/browse', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/browse')>()),
	listDeclaredGroups: vi.fn(async () => [])
}));
vi.mock('$lib/groups/server/identities', () => ({
	knownHandles: vi.fn(async () => new Map())
}));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import {
	breakSession,
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { listDeclaredGroups } from '$lib/groups/server/browse';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { membersSpaceReader } from '$lib/groups/server/__fixtures__/members-space';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import { hostDown, spaceReader } from '$lib/groups/server/__fixtures__/space-reader';

import { createGroup } from '$lib/groups/server/db/groups';
const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	resetReaderHost();
});

/** An undeclared group someone else owns, with ALICE's row in it and, when
 *  `recorded`, her membership record in its members space. */
async function joined(name: string, groupDid: string, recorded: boolean) {
	const { spaces } = await seedGroup({
		harness,
		groupDid,
		ownerDid: OWNER,
		name,
		members: { [ALICE]: 'member' }
	});
	return membersSpaceReader(spaces.membersSpaceUri, groupDid, recorded ? [ALICE] : []);
}

/** A host that fails every read of the group's spaces. */
const down = (groupDid: string) => spaceReader(groupDid, { fail: hostDown(502) });

async function browse() {
	return (await load({
		locals: { did: ALICE },
		platform: { env: { DB: db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as {
		groups: { name: string | null; visibility: string | null }[];
	};
}

describe('/groups load', () => {
	it("lists an undeclared group by the caller's row, reading none of its spaces", async () => {
		const readers = new Map([
			['did:plc:kept', await joined('Kept', 'did:plc:kept', true)],
			['did:plc:gone', await joined('Gone', 'did:plc:gone', false)]
		]);
		for (const [did, reader] of readers) serveReader(did, reader);

		expect((await browse()).groups.map((g) => g.name).sort()).toEqual(['Gone', 'Kept']);
		for (const reader of readers.values()) expect(reader.calls).toEqual([]);
		expect(fixtureSessions.reads).toBe(0);
	});

	// Browse shows what placement says, with no host read per row: a group in
	// the declaration index is public, and one the caller reaches only through
	// their own groups, undeclared, is private.
	it('browse marks a group private when the caller sees it only through their own undeclared groups', async () => {
		await createGroup(db, { groupDid: 'did:plc:listed', ownerDid: ALICE, name: 'Listed' });
		await createGroup(db, { groupDid: 'did:plc:hidden', ownerDid: ALICE, name: 'Hidden' });
		vi.mocked(listDeclaredGroups).mockResolvedValueOnce([
			{ did: 'did:plc:listed', createdAt: new Date().toISOString() }
		]);

		const data = (await load({
			locals: { did: ALICE },
			platform: { env: { DB: db, OAUTH_SESSIONS: fixtureSessions } }
		} as unknown as Parameters<typeof load>[0])) as {
			groups: { name: string | null; visibility: string | null }[];
		};

		expect(Object.fromEntries(data.groups.map((g) => [g.name, g.visibility]))).toEqual({
			Listed: 'public',
			Hidden: 'private'
		});
		expect(fixtureSessions.reads).toBe(0);
	});

	// Nothing is read, so a members space that errors or a session that cannot
	// be restored changes nothing about the list: the row answers.
	it.each([
		['whose members space errors', () => serveReader('did:plc:stale', down('did:plc:stale'))],
		['whose session cannot be restored', () => breakSession('did:plc:stale')]
	])('lists an undeclared group %s, as its row says', async (_, failStale) => {
		const kept = await joined('Kept', 'did:plc:kept', true);
		await joined('Stale', 'did:plc:stale', false);
		serveReader('did:plc:kept', kept);
		failStale();

		expect((await browse()).groups.map((g) => g.name).sort()).toEqual(['Kept', 'Stale']);
		expect(kept.calls).toEqual([]);
	});

	// A group this deployment holds no credential for is listed as any other:
	// its row answers.
	it('lets the row answer for an undeclared group this deployment holds no credential for', async () => {
		await joined('Uncredentialed', 'did:plc:uncredentialed', false);
		serveReader('did:plc:uncredentialed', null);

		expect((await browse()).groups.map((g) => g.name)).toEqual(['Uncredentialed']);
	});

	// A members space that is down cannot hide a group from its owner, since
	// none is read.
	it("lists the caller's own undeclared group without reading its members space", async () => {
		await seedGroup({ harness, groupDid: 'did:plc:mine', ownerDid: ALICE, name: 'Mine' });
		serveReader('did:plc:mine', down('did:plc:mine'));

		expect((await browse()).groups).toEqual([
			expect.objectContaining({ name: 'Mine', visibility: 'private' })
		]);
		expect(fixtureSessions.reads).toBe(0);
	});
});

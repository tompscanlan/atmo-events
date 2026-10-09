import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What this route decides for /groups: that the record check `listGroups` asks
// for an undeclared group is the signed-in caller's own standing, read from the
// group's members space. The listing rules are pinned in
// lib/groups/server/repo.test.ts; the index and the handle cache are stubbed
// here because neither decides anything about the check.
vi.mock('$lib/groups/server/declaration-index', () => ({
	listDeclaredGroups: vi.fn(async () => [])
}));
vi.mock('$lib/groups/server/handles', () => ({
	knownHandles: vi.fn(async () => new Map())
}));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { type GroupSpaceReader } from '$lib/groups/server/about-read';
import {
	breakSession,
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { listDeclaredGroups } from '$lib/groups/server/declaration-index';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { membersSpaceReader } from '$lib/groups/server/__fixtures__/members-space';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { spaceUri } from '$lib/groups/server/spaces';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '$lib/groups/types';

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
	const group = await createGroup(db, { groupDid, ownerDid: OWNER, name });
	const members = spaceUri(groupDid, MEMBERS_SPACE_TYPE, 'self');
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self'),
		membersSpaceUri: members
	});
	await addMember(db, group.id, ALICE, 'member');
	return membersSpaceReader(members, groupDid, recorded ? [ALICE] : []);
}

/** A members space that fails every read. */
const down: GroupSpaceReader = {
	async get() {
		throw new Error('com.atproto.space.getRecord failed: 502');
	},
	async list() {
		throw new Error('com.atproto.space.listRecords failed: 502');
	},
	async getSpace() {
		throw new Error('com.atproto.simplespace.getSpace failed: 502');
	}
};

async function browse() {
	return (await load({
		locals: { did: ALICE },
		platform: { env: { DB: db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as {
		groups: { name: string | null; visibility: string | null }[];
	};
}

describe('/groups load', () => {
	it("checks an undeclared group against the signed-in caller's membership record", async () => {
		const readers = new Map([
			['did:plc:kept', await joined('Kept', 'did:plc:kept', true)],
			['did:plc:gone', await joined('Gone', 'did:plc:gone', false)]
		]);
		for (const [did, reader] of readers) serveReader(did, reader);

		const data = (await load({
			locals: { did: ALICE },
			platform: { env: { DB: db, OAUTH_SESSIONS: fixtureSessions } }
		} as unknown as Parameters<typeof load>[0])) as { groups: { name: string | null }[] };

		expect(data.groups.map((g) => g.name)).toEqual(['Kept']);
		expect(readers.get('did:plc:gone')!.reads).toBeGreaterThan(0);
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

	// A row alone does not list a group the caller does not own: it may be the
	// trace of a removal whose row delete failed. When the membership record
	// cannot be read, the check answers no, and the rest of browse is as it
	// would be.
	it('leaves out an undeclared group whose members space errors', async () => {
		const kept = await joined('Kept', 'did:plc:kept', true);
		await joined('Stale', 'did:plc:stale', false);
		serveReader('did:plc:kept', kept);
		serveReader('did:plc:stale', down);
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect((await browse()).groups.map((g) => g.name)).toEqual(['Kept']);
		logged.mockRestore();
	});

	it('leaves out an undeclared group whose reader cannot be built', async () => {
		const kept = await joined('Kept', 'did:plc:kept', true);
		await joined('Stale', 'did:plc:stale', false);
		serveReader('did:plc:kept', kept);
		breakSession('did:plc:stale');
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		expect((await browse()).groups.map((g) => g.name)).toEqual(['Kept']);
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	// A group this deployment holds no credential for has no reader, and that
	// is not a failed read: its row answers, as it does on the group page.
	it('lets the row answer for an undeclared group this deployment holds no credential for', async () => {
		await joined('Uncredentialed', 'did:plc:uncredentialed', false);
		serveReader('did:plc:uncredentialed', null);

		expect((await browse()).groups.map((g) => g.name)).toEqual(['Uncredentialed']);
	});

	// The caller's own groups are never checked, so a members space that is
	// down cannot hide a group from its owner.
	it("lists the caller's own undeclared group without reading its members space", async () => {
		const mine = await createGroup(db, { groupDid: 'did:plc:mine', ownerDid: ALICE, name: 'Mine' });
		await recordGroupSpaces(db, mine.id, {
			aboutSpaceUri: spaceUri('did:plc:mine', ABOUT_SPACE_TYPE, 'self'),
			membersSpaceUri: spaceUri('did:plc:mine', MEMBERS_SPACE_TYPE, 'self')
		});
		serveReader('did:plc:mine', down);

		expect((await browse()).groups).toEqual([
			expect.objectContaining({ name: 'Mine', visibility: 'private' })
		]);
		expect(fixtureSessions.reads).toBe(0);
	});
});

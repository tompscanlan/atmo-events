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
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { groupSpaceReader } from '$lib/groups/server/about-read';
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
});

/** An undeclared group someone else owns, with ALICE's row in it and, when
 *  `recorded`, her membership record in its members space. */
async function joined(name: string, groupDid: string, recorded: boolean) {
	const group = await createGroup(db, { groupDid, ownerDid: OWNER, name, visibility: 'private' });
	const members = spaceUri(groupDid, MEMBERS_SPACE_TYPE, 'self');
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self'),
		membersSpaceUri: members
	});
	await addMember(db, group.id, ALICE, 'member');
	return membersSpaceReader(members, groupDid, recorded ? [ALICE] : []);
}

describe('/groups load', () => {
	it("checks an undeclared group against the signed-in caller's membership record", async () => {
		const readers = new Map([
			['did:plc:kept', await joined('Kept', 'did:plc:kept', true)],
			['did:plc:gone', await joined('Gone', 'did:plc:gone', false)]
		]);
		vi.mocked(groupSpaceReader).mockImplementation(
			async (_env, _db, group) => readers.get(group.group_did) ?? null
		);

		const data = (await load({
			locals: { did: ALICE },
			platform: { env: { DB: db } }
		} as unknown as Parameters<typeof load>[0])) as { groups: { name: string | null }[] };

		expect(data.groups.map((g) => g.name)).toEqual(['Kept']);
		expect(readers.get('did:plc:gone')!.reads).toBeGreaterThan(0);
	});
});

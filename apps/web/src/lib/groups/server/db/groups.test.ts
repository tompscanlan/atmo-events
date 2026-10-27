import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from '../__fixtures__/d1-sqlite';
import { GroupRuleError } from './rules';
import { createGroup, getGroupByDid, recordGroupSpaces, updateGroup } from './groups';
import { listMembers } from './roster';
import { getCallerMembership } from '../standing';

const CREATOR = 'did:plc:creator';
const ALICE = 'did:plc:alice';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

function group(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
	return createGroup(db, { groupDid: GROUP_DID, creatorDid: CREATOR, name: 'Kona', ...overrides });
}

const count = (table: string) => harness.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

describe('createGroup', () => {
	it('notes the creator as an admin row, with the spaces not yet recorded', async () => {
		const created = await group();

		expect(await listMembers(db, created.id)).toEqual([
			expect.objectContaining({ did: CREATOR, role: 'admin' })
		]);
		expect(created.about_space_uri).toBeNull();
		expect(created.members_space_uri).toBeNull();
	});

	it('grants nobody anything, and puts nobody on the roster, from the rows alone', async () => {
		const created = await group();
		for (const did of [CREATOR, ALICE, null]) {
			const membership = await getCallerMembership(db, created, did, null);
			expect(membership.permissions.size, String(did)).toBe(0);
			expect(membership.onRoster, String(did)).toBe(false);
		}
		expect((await getCallerMembership(db, created, CREATOR, null)).role).toBe('admin');
	});

	it('rolls back as one transaction, and reports a duplicate DID as did-taken', async () => {
		await group();
		const again = group({ name: 'Kona, again' });
		await expect(again).rejects.toBeInstanceOf(GroupRuleError);
		await expect(again).rejects.toMatchObject({ reason: 'did-taken' });
		expect(count('groups')).toEqual({ n: 1 });
		expect(count('memberships')).toEqual({ n: 1 });
	});
});

describe('the row after the create', () => {
	it('records the spaces, and takes a new name and description', async () => {
		const created = await group();
		await recordGroupSpaces(db, created.id, {
			aboutSpaceUri: `at://${GROUP_DID}/space/group.opensocial.meta/self`,
			membersSpaceUri: `at://${GROUP_DID}/space/group.opensocial.members/self`
		});
		await updateGroup(db, created.id, { name: 'Kona Night', description: null });

		expect(await getGroupByDid(db, GROUP_DID)).toMatchObject({
			name: 'Kona Night',
			description: null,
			about_space_uri: `at://${GROUP_DID}/space/group.opensocial.meta/self`
		});
	});
});

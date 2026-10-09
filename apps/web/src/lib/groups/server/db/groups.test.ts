// The group rows against the real schema: creation as one transaction, and the
// rehearsal that costs nothing. Each case is a rule a route trusts without
// re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '../../permissions';
import { sqliteD1, type SqliteD1 } from '../__fixtures__/d1-sqlite';
import { GroupRuleError } from './rules';
import { createGroup, rehearseCreateGroup, rolePermissions } from './groups';
import { listMembers } from './roster';
import { getCallerMembership } from '../standing';
import { ensureGroupsSchema } from '../schema';

const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

function group(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
	return createGroup(db, {
		groupDid: 'did:plc:jcwgw6fcnb5vyoid7nz7sl26',
		ownerDid: OWNER,
		name: 'Kona',
		...overrides
	});
}

describe('createGroup', () => {
	it('seeds the three roles with their bundles and exactly one active owner', async () => {
		const created = await group();

		const bundles = await rolePermissions(db, created.id);
		expect(Object.keys(bundles).sort()).toEqual(['admin', 'member', 'owner']);
		for (const [role, expected] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
			expect(bundles[role].slice().sort(), role).toEqual([...expected].sort());
		}

		const members = await listMembers(db, created.id);
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ did: OWNER, role: 'owner' });
		expect(created.require_approval).toBe(1);
		// createGroup does not provision: the spaces are a PDS call the caller makes
		// next, so a fresh row says "not yet" rather than claiming a space exists.
		expect(created.about_space_uri).toBeNull();
		expect(created.members_space_uri).toBeNull();
	});

	it('gives the owner every enforced permission and the applicant none', async () => {
		const created = await group();
		const owner = await getCallerMembership(db, created, OWNER, null);
		expect(owner.role).toBe('owner');
		expect(owner.permissions.has('MANAGE_EVENTS')).toBe(true);

		const stranger = await getCallerMembership(db, created, ALICE, null);
		expect(stranger.role).toBeNull();
		expect(stranger.permissions.size).toBe(0);

		const anonymous = await getCallerMembership(db, created, null, null);
		expect(anonymous.permissions.size).toBe(0);
	});

	// D1 runs a batch as one transaction. The group DID is the only uniqueness a
	// create can trip (the handle registration decides the name, so there is no
	// second reservation), and tripping it must leave nothing behind: not an
	// orphan group with no roles, and not a half-written roster.
	it('rolls the whole creation back when a unique constraint fails', async () => {
		await group();
		await expect(group()).rejects.toThrow(GroupRuleError);
		const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM groups').get();
		expect(rows).toEqual({ n: 1 });
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 3 });
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 1 });
	});

	// The only uniqueness tag a create can answer with, which is why it is worth
	// pinning: a caller mapping it back to a form field has exactly one field to
	// point at. A different name over the same DID changes nothing.
	it('reports a duplicate DID as did-taken', async () => {
		await group();
		await expect(group({ name: 'Kona, again' })).rejects.toMatchObject({ reason: 'did-taken' });
	});
});

// The create path runs this before the mint, so it must cost nothing: a
// rehearsal that left a row behind would be a worse bug than the one it
// prevents.
describe('rehearseCreateGroup', () => {
	function counts() {
		return ['groups', 'roles', 'role_permissions', 'memberships'].map(
			(table) => harness.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
		);
	}

	it('proves the row would land and leaves every table as it found it', async () => {
		await group();
		const before = counts();

		await expect(rehearseCreateGroup(db, { ownerDid: ALICE, name: 'Rehearsed' })).resolves.toBe(
			undefined
		);

		expect(counts()).toEqual(before);
	});

	// Drift, as a table that changed under IF NOT EXISTS would present it: the
	// INSERT is refused, and the rehearsal says so with the table's own words.
	it('meets the refusal the real create would meet', async () => {
		harness.raw.exec(
			`CREATE TRIGGER drifted BEFORE INSERT ON groups
			 BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: groups.legacy'); END`
		);
		await expect(rehearseCreateGroup(db, { ownerDid: OWNER, name: 'Kona' })).rejects.toThrow(
			/groups\.legacy/
		);
		expect(counts()).toEqual([0, 0, 0, 0]);
	});

	// Drift that loses the owner without a refusal: with the owner-role trigger
	// gone, the batch inserts the row and no owner membership, and no statement
	// fails. Only the rehearsal's closing check can see it, and a create that went
	// ahead would mint a group nobody owns.
	it('refuses when the row would land without its owner membership', async () => {
		// The schema self-heal runs once per isolate and would put the trigger
		// back, so it has run before the trigger goes.
		await ensureGroupsSchema(db);
		harness.raw.exec('DROP TRIGGER groups_seed_owner_role');

		await expect(rehearseCreateGroup(db, { ownerDid: OWNER, name: 'Kona' })).rejects.toThrow(
			/owner membership/
		);
		expect(counts()).toEqual([0, 0, 0, 0]);
	});
});

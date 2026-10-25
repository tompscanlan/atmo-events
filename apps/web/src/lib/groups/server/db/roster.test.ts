import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from '../__fixtures__/d1-sqlite';
import { createGroup } from './groups';
import { addMember, changeMemberRole, countMembers, noteJoinRequest, removeMember } from './roster';
import { getCallerMembership } from '../standing';

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
		creatorDid: OWNER,
		name: 'Kona',
		...overrides
	});
}

describe('joining', () => {
	const requests = () =>
		harness.raw.prepare('SELECT did, status FROM join_requests ORDER BY created_at').all();

	it('notes a pending request and no roster row, and a second note is already pending', async () => {
		const created = await group();
		expect(await noteJoinRequest(db, created.id, ALICE, 'hello')).toBe('pending');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).not.toBeNull();
		expect(await countMembers(db, created.id)).toBe(1);

		expect(await noteJoinRequest(db, created.id, ALICE, 'hello again')).toBe('already-pending');
	});

	it('refuses to add a DID already on the roster, and changes nothing', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		harness.raw
			.prepare(
				`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
				 VALUES ('stale', ?, ?, 'pending', 0, 0)`
			)
			.run(created.id, ALICE);

		await expect(addMember(db, created.id, ALICE, 'admin', OWNER)).rejects.toMatchObject({
			name: 'GroupRuleError',
			reason: 'constraint'
		});

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('member');
		expect(membership.pendingRequestId).toBe('stale');
	});

	it('closes a pending request when the DID is added', async () => {
		const created = await group();
		await noteJoinRequest(db, created.id, ALICE, 'hello');

		await addMember(db, created.id, ALICE, 'admin', OWNER);

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		expect(requests()).toEqual([{ did: ALICE, status: 'approved' }]);
		expect(
			harness.raw.prepare(`SELECT decided_by_did AS by FROM join_requests WHERE did = ?`).get(ALICE)
		).toEqual({ by: OWNER });
	});

	it('closes a pending request when an open join admits the DID', async () => {
		const created = await group();
		await noteJoinRequest(db, created.id, ALICE, 'hello');

		await addMember(db, created.id, ALICE, 'member');

		expect((await getCallerMembership(db, created, ALICE, null)).pendingRequestId).toBeNull();
		expect(requests()).toEqual([{ did: ALICE, status: 'approved' }]);
	});
});

describe('roster changes', () => {
	it('lets a member leave, and the creator too', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');

		await removeMember(db, created.id, ALICE);
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBeNull();

		await removeMember(db, created.id, OWNER);
		expect((await getCallerMembership(db, created, OWNER, null)).role).toBeNull();
	});

	it('moves a role, keeps one atmo does not know, and refuses a DID off the roster', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		await changeMemberRole(db, created.id, ALICE, 'moderator');
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBe('moderator');

		await changeMemberRole(db, created.id, OWNER, 'member');
		expect((await getCallerMembership(db, created, OWNER, null)).role).toBe('member');

		await expect(
			changeMemberRole(db, created.id, 'did:plc:stranger', 'admin')
		).rejects.toMatchObject({ reason: 'not-found' });
	});
});

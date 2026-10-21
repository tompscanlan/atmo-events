// The roster rows against the real schema: the notes of join requests, and role
// changes. Each case is a rule a route trusts without re-checking.
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
		ownerDid: OWNER,
		name: 'Kona',
		...overrides
	});
}

// The roster's rows follow the host's answers: a note that someone asked, and
// a row once the host has admitted them.
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

		// The partial unique index is what stops a second request; the repo turns
		// that refusal into an outcome rather than an error.
		expect(await noteJoinRequest(db, created.id, ALICE, 'hello again')).toBe('already-pending');
	});

	// A DID can hold a row and a pending request at once only through data that
	// predates the direct add closing requests. Adding it again is refused, and
	// neither the row nor the request moves.
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

	// An add is an answer to the applicant's request, so it closes it. Left
	// pending, the request would sit in the queue for a member.
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

	// The same holds for an open join at the host by someone whose request
	// predates the group turning approval off: they are in, so the request is
	// answered, by nobody.
	it('closes a pending request when an open join admits the DID', async () => {
		const created = await group();
		await noteJoinRequest(db, created.id, ALICE, 'hello');

		await addMember(db, created.id, ALICE, 'member');

		expect((await getCallerMembership(db, created, ALICE, null)).pendingRequestId).toBeNull();
		expect(requests()).toEqual([{ did: ALICE, status: 'approved' }]);
	});
});

describe('roster changes', () => {
	// No owner (TS, 2026-10-20): the creator's row is one like any other.
	it('lets a member leave, and the creator too', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');

		await removeMember(db, created.id, ALICE);
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBeNull();

		await removeMember(db, created.id, OWNER);
		expect((await getCallerMembership(db, created, OWNER, null)).role).toBeNull();
	});

	it('promotes a member to admin, refuses an unknown role, and demotes the creator', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		await changeMemberRole(db, created.id, ALICE, 'admin');

		// The row moves. What the role may do is the records' to say, not the row's.
		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');

		await expect(
			changeMemberRole(db, created.id, ALICE, 'owner' as 'admin')
		).rejects.toBeInstanceOf(Error);
		await changeMemberRole(db, created.id, OWNER, 'member');
		expect((await getCallerMembership(db, created, OWNER, null)).role).toBe('member');
	});
});

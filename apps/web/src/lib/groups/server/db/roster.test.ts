// The roster rows against the real schema: the approval flow, the invite-only
// rule, and role changes. Each case is a rule a route trusts without re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from '../__fixtures__/d1-sqlite';
import { createGroup } from './groups';
import {
	addMember,
	approveJoinRequest,
	changeMemberRole,
	countMembers,
	listJoinRequests,
	removeMember,
	requestJoin
} from './roster';
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

describe('joining', () => {
	it('records a pending request and no roster row when approval is required', async () => {
		const created = await group();
		expect(await requestJoin(db, created, ALICE, 'hello', 'public')).toBe('pending');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).not.toBeNull();
		expect(await countMembers(db, created.id)).toBe(1);

		// The partial unique index is what stops a second request; the repo turns
		// that refusal into an outcome rather than an error.
		expect(await requestJoin(db, created, ALICE, 'hello again', 'public')).toBe('already-pending');
	});

	it('puts the caller straight on the roster when approval is off', async () => {
		const created = await group({ requireApproval: false });
		expect(await requestJoin(db, created, ALICE, null, 'public')).toBe('joined');
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBe('member');
		expect(await requestJoin(db, created, ALICE, null, 'public')).toBe('already-member');
	});

	it('approves into the chosen role and closes the request in one step', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, null, 'public');
		const pending = (await getCallerMembership(db, created, ALICE, null)).pendingRequestId!;

		await approveJoinRequest(db, created.id, pending, OWNER, 'admin');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		await expect(approveJoinRequest(db, created.id, pending, OWNER)).rejects.toMatchObject({
			reason: 'not-found'
		});
	});

	// A DID can hold a row and a pending request at once only through data that
	// predates the direct add closing requests, or a direct add racing the
	// approval. Approving it anyway would leave the row at its old role while
	// the caller publishes the requested one, and the record wins in the gate.
	// So the approval is refused, as a direct add of a rostered DID is, and
	// neither the row nor the request moves.
	it('refuses to approve a request for a DID already on the roster, and changes nothing', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		harness.raw
			.prepare(
				`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
				 VALUES ('stale', ?, ?, 'pending', 0, 0)`
			)
			.run(created.id, ALICE);

		await expect(approveJoinRequest(db, created.id, 'stale', OWNER, 'admin')).rejects.toMatchObject(
			{ name: 'GroupRuleError', reason: 'constraint' }
		);

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('member');
		expect(membership.pendingRequestId).toBe('stale');
	});

	// A direct add is an answer to the applicant's request, so it closes it.
	// Left pending, the request would sit in the queue for a member, and
	// approving it later would try to admit them a second time.
	it('closes a pending request when the DID is added directly', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, 'hello', 'public');

		await addMember(db, created.id, ALICE, 'admin', OWNER);

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		expect(await listJoinRequests(db, created.id, 'all')).toMatchObject([
			{ did: ALICE, status: 'approved' }
		]);
		expect(
			harness.raw.prepare(`SELECT decided_by_did AS by FROM join_requests WHERE did = ?`).get(ALICE)
		).toEqual({ by: OWNER });
	});

	// The same holds for an open join by someone whose request predates the
	// group turning approval off: they are in, so the request is answered.
	it('closes a pending request when an open join admits the DID', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, 'hello', 'public');
		harness.raw.prepare(`UPDATE groups SET require_approval = 0 WHERE id = ?`).run(created.id);

		expect(await requestJoin(db, { ...created, require_approval: 0 }, ALICE, null, 'public')).toBe(
			'joined'
		);

		expect((await getCallerMembership(db, created, ALICE, null)).pendingRequestId).toBeNull();
		expect(await listJoinRequests(db, created.id, 'pending')).toEqual([]);
	});
});

// Whether a group takes self-service joins is a question about its visibility,
// and its visibility is what its host enforces: the about space's read policy,
// which the route reads and hands in. D1 does not store it, so what is handed
// in is the only answer, whatever the row's approval setting says. The create
// and the settings save refuse the open-join configuration too
// (`approvalRefusal`), but that alone is not enough: a private group that
// requires approval would still take a pending request from a stranger.
describe('the join refusal reads the host, not the row', () => {
	// The row's approval is a cache of the profile's join policy, and nothing
	// forces it on for a private group, so a private group can sit at 0. The
	// refusal comes first, before approval is consulted at all.
	it('a private group refuses a join whatever its cached approval says', async () => {
		const created = await group({ requireApproval: false });
		expect(created.require_approval).toBe(0);

		await expect(requestJoin(db, created, ALICE, 'let me in', 'private')).rejects.toMatchObject({
			reason: 'invite-only'
		});
		// A visibility nobody read is not a public one.
		await expect(requestJoin(db, created, ALICE, 'let me in', null)).rejects.toMatchObject({
			reason: 'invite-only'
		});

		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM join_requests').get()).toEqual({ n: 0 });
		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(await countMembers(db, created.id)).toBe(1);
	});

	it('answers already-member for a DID on the roster, whatever the host says', async () => {
		const created = await group({ requireApproval: false });
		await addMember(db, created.id, ALICE, 'member');

		for (const visibility of ['public', 'private', null] as const) {
			expect(await requestJoin(db, created, ALICE, null, visibility)).toBe('already-member');
		}
	});
});

describe('roster changes', () => {
	it('lets a member leave but never the owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');

		await removeMember(db, created.id, ALICE);
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBeNull();

		// The trigger refuses; the repo must surface that as a rule, not a 500.
		await expect(removeMember(db, created.id, OWNER)).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});

	it('promotes a member to admin, and refuses to promote anyone to owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		await changeMemberRole(db, created.id, ALICE, 'admin');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.permissions.has('MANAGE_EVENTS')).toBe(true);

		await expect(
			changeMemberRole(db, created.id, ALICE, 'owner' as 'admin')
		).rejects.toBeInstanceOf(Error);
		await expect(changeMemberRole(db, created.id, OWNER, 'admin')).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});
});

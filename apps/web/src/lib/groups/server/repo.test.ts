// The repository against the real schema: creation-as-one-transaction, the
// approval flow, and the visibility filter. Each case is a rule a route trusts
// without re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '../permissions';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	countActiveMembers,
	createGroup,
	getCallerMembership,
	listGroups,
	listMembers,
	removeMember,
	requestJoin,
	rolePermissions,
	setMemberStatus
} from './repo';

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

function group(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
	return createGroup(db, {
		groupDid: 'did:plc:jcwgw6fcnb5vyoid7nz7sl26',
		ownerDid: OWNER,
		name: 'Kona',
		slug: 'kona',
		...overrides
	});
}

describe('createGroup', () => {
	it('seeds the five roles with the legacy bundles and exactly one active owner', async () => {
		const created = await group();

		const bundles = await rolePermissions(db, created.id);
		expect(Object.keys(bundles).sort()).toEqual(['admin', 'guest', 'member', 'moderator', 'owner']);
		for (const [role, expected] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
			expect(bundles[role].slice().sort(), role).toEqual([...expected].sort());
		}

		const members = await listMembers(db, created.id);
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ did: OWNER, role: 'owner', status: 'active' });
		expect(created.require_approval).toBe(1);
		// createGroup does not provision: the spaces are a PDS call the caller makes
		// next, so a fresh row says "not yet" rather than claiming a space exists.
		expect(created.about_space_uri).toBeNull();
		expect(created.members_space_uri).toBeNull();
	});

	it('gives the owner every enforced permission and the applicant none', async () => {
		const created = await group();
		const owner = await getCallerMembership(db, created.id, OWNER);
		expect(owner.role).toBe('owner');
		expect(owner.permissions.has('MANAGE_EVENTS')).toBe(true);

		const stranger = await getCallerMembership(db, created.id, ALICE);
		expect(stranger.role).toBeNull();
		expect(stranger.permissions.size).toBe(0);

		const anonymous = await getCallerMembership(db, created.id, null);
		expect(anonymous.permissions.size).toBe(0);
	});

	// D1 runs a batch as one transaction. A slug collision must therefore leave
	// nothing behind — not an orphan group with no roles, and not a half roster.
	it('rolls the whole creation back when a unique constraint fails', async () => {
		await group();
		await expect(group({ groupDid: 'did:plc:other', slug: 'kona' })).rejects.toThrow(
			GroupRuleError
		);
		const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM groups').get();
		expect(rows).toEqual({ n: 1 });
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 5 });
	});

	it('reports a duplicate DID distinctly from a duplicate slug', async () => {
		await group();
		await expect(group({ slug: 'kona-2' })).rejects.toMatchObject({ reason: 'did-taken' });
		await expect(group({ groupDid: 'did:plc:other' })).rejects.toMatchObject({
			reason: 'slug-taken'
		});
	});
});

describe('joining', () => {
	it('records a pending request and no roster row when approval is required', async () => {
		const created = await group();
		expect(await requestJoin(db, created, ALICE, 'hello')).toBe('pending');

		const membership = await getCallerMembership(db, created.id, ALICE);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).not.toBeNull();
		expect(await countActiveMembers(db, created.id)).toBe(1);

		// The partial unique index is what stops a second request; the repo turns
		// that refusal into an outcome rather than an error.
		expect(await requestJoin(db, created, ALICE, 'hello again')).toBe('already-pending');
	});

	it('puts the caller straight on the roster when approval is off', async () => {
		const created = await group({ requireApproval: false, slug: 'open' });
		expect(await requestJoin(db, created, ALICE, null)).toBe('joined');
		expect((await getCallerMembership(db, created.id, ALICE)).role).toBe('member');
		expect(await requestJoin(db, created, ALICE, null)).toBe('already-member');
	});

	it('approves into the chosen role and closes the request in one step', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, null);
		const pending = (await getCallerMembership(db, created.id, ALICE)).pendingRequestId!;

		await approveJoinRequest(db, created.id, pending, OWNER, 'admin');

		const membership = await getCallerMembership(db, created.id, ALICE);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		await expect(approveJoinRequest(db, created.id, pending, OWNER)).rejects.toMatchObject({
			reason: 'not-found'
		});
	});
});

describe('roster changes', () => {
	it('lets a member leave but never the owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');

		await removeMember(db, created.id, ALICE);
		expect((await getCallerMembership(db, created.id, ALICE)).role).toBeNull();

		// The trigger refuses; the repo must surface that as a rule, not a 500.
		await expect(removeMember(db, created.id, OWNER)).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});

	it('promotes a member to admin, and refuses to promote anyone to owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		await changeMemberRole(db, created.id, ALICE, 'admin');

		const membership = await getCallerMembership(db, created.id, ALICE);
		expect(membership.role).toBe('admin');
		expect(membership.permissions.has('MANAGE_EVENTS')).toBe(true);

		await expect(
			changeMemberRole(db, created.id, ALICE, 'owner' as 'admin')
		).rejects.toBeInstanceOf(Error);
		await expect(changeMemberRole(db, created.id, OWNER, 'admin')).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});

	// A suspended member keeps their row and their role, but resolves to no
	// permissions — which is what makes suspension mean anything.
	it('strips a suspended member of every permission', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'admin');
		expect((await getCallerMembership(db, created.id, ALICE)).permissions.size).toBeGreaterThan(0);

		await setMemberStatus(db, created.id, ALICE, 'suspended');
		const suspended = await getCallerMembership(db, created.id, ALICE);
		expect(suspended.role).toBe('admin');
		expect(suspended.status).toBe('suspended');
		expect(suspended.permissions.size).toBe(0);

		await expect(setMemberStatus(db, created.id, OWNER, 'suspended')).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});
});

describe('browse visibility', () => {
	it('shows anonymous callers only published public groups', async () => {
		await group({ slug: 'pub', groupDid: 'did:plc:a', status: 'published' });
		await group({ slug: 'draft', groupDid: 'did:plc:b' });
		await group({
			slug: 'hidden',
			groupDid: 'did:plc:c',
			status: 'published',
			visibility: 'unlisted'
		});
		await group({
			slug: 'secret',
			groupDid: 'did:plc:d',
			status: 'published',
			visibility: 'private'
		});

		const anonymous = await listGroups(db, { callerDid: null });
		expect(anonymous.map((g) => g.slug)).toEqual(['pub']);
	});

	it('adds the caller own and joined groups at any status or visibility', async () => {
		const secret = await group({
			slug: 'secret',
			groupDid: 'did:plc:d',
			status: 'published',
			visibility: 'private'
		});
		await addMember(db, secret.id, ALICE, 'member');

		expect((await listGroups(db, { callerDid: OWNER })).map((g) => g.slug)).toEqual(['secret']);
		expect((await listGroups(db, { callerDid: ALICE })).map((g) => g.slug)).toEqual(['secret']);
		expect((await listGroups(db, { callerDid: BOB })).map((g) => g.slug)).toEqual([]);
	});
});

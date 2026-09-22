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
	getGroupByDid,
	listGroups,
	listMembers,
	removeMember,
	requestJoin,
	rolePermissions,
	setMemberStatus,
	updateGroup
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
		expect(members[0]).toMatchObject({ did: OWNER, role: 'owner', status: 'active' });
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
	// create can trip now — the handle registry adjudicates the name, so there is
	// no second reservation — and tripping it must leave nothing behind: not an
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
	// point at. A different name over the same DID changes nothing. (FR-001a.)
	it('reports a duplicate DID as did-taken', async () => {
		await group();
		await expect(group({ name: 'Kona, again' })).rejects.toMatchObject({ reason: 'did-taken' });
	});
});

// THE ROUTE LOOKUP. Every group URL carries the DID, so this is the one query
// standing between a request and a page; a handle URL is resolved to a DID
// before it gets here (see ./route-context.ts).
describe('getGroupByDid', () => {
	it('finds the group a DID names, and answers null for a DID it holds none for', async () => {
		const created = await group();

		expect(await getGroupByDid(db, created.group_did)).toMatchObject({
			id: created.id,
			group_did: created.group_did,
			name: 'Kona'
		});
		// Null rather than a throw: "no group here" is the caller's 404 to decide,
		// and it is the same answer a private group gives (route-context.ts).
		expect(await getGroupByDid(db, 'did:plc:nosuchgroup')).toBeNull();
	});
});

describe('joining', () => {
	it('records a pending request and no roster row when approval is required', async () => {
		const created = await group();
		expect(await requestJoin(db, created, ALICE, 'hello')).toBe('pending');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).not.toBeNull();
		expect(await countActiveMembers(db, created.id)).toBe(1);

		// The partial unique index is what stops a second request; the repo turns
		// that refusal into an outcome rather than an error.
		expect(await requestJoin(db, created, ALICE, 'hello again')).toBe('already-pending');
	});

	it('puts the caller straight on the roster when approval is off', async () => {
		const created = await group({ requireApproval: false });
		expect(await requestJoin(db, created, ALICE, null)).toBe('joined');
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBe('member');
		expect(await requestJoin(db, created, ALICE, null)).toBe('already-member');
	});

	it('approves into the chosen role and closes the request in one step', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, null);
		const pending = (await getCallerMembership(db, created, ALICE, null)).pendingRequestId!;

		await approveJoinRequest(db, created.id, pending, OWNER, 'admin');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		await expect(approveJoinRequest(db, created.id, pending, OWNER)).rejects.toMatchObject({
			reason: 'not-found'
		});
	});
});

// om-5oxc8. Two rules, deliberately in two layers: the schema refuses the
// open-join CONFIGURATION, `requestJoin` refuses the ACT. Either alone leaves a
// way in — a group that predates the trigger, or a caller that skips the form.
describe('private groups are invite-only', () => {
	it('refuses a self-service join, and records nothing on the way out', async () => {
		const created = await group({ visibility: 'private' });

		await expect(requestJoin(db, created, ALICE, 'let me in')).rejects.toMatchObject({
			reason: 'invite-only'
		});

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).toBeNull();
		expect(await countActiveMembers(db, created.id)).toBe(1);
	});

	it('still answers already-member for someone on the roster', async () => {
		const created = await group({ visibility: 'private' });
		await addMember(db, created.id, ALICE, 'member');
		expect(await requestJoin(db, created, ALICE, null)).toBe('already-member');
	});

	it('cannot be created open-join', async () => {
		await expect(group({ visibility: 'private', requireApproval: false })).rejects.toMatchObject({
			reason: 'private-needs-approval'
		});
	});

	it('cannot be edited into open-join, in either order', async () => {
		const open = await group({ requireApproval: false });
		await expect(updateGroup(db, open.id, { visibility: 'private' })).rejects.toMatchObject({
			reason: 'private-needs-approval'
		});

		const closed = await group({ visibility: 'private', groupDid: 'did:plc:second' });
		await expect(updateGroup(db, closed.id, { requireApproval: false })).rejects.toMatchObject({
			reason: 'private-needs-approval'
		});
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

	// A suspended member keeps their row and their role, but resolves to no
	// permissions — which is what makes suspension mean anything.
	it('strips a suspended member of every permission', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'admin');
		expect((await getCallerMembership(db, created, ALICE, null)).permissions.size).toBeGreaterThan(
			0
		);

		await setMemberStatus(db, created.id, ALICE, 'suspended');
		const suspended = await getCallerMembership(db, created, ALICE, null);
		expect(suspended.role).toBe('admin');
		expect(suspended.status).toBe('suspended');
		expect(suspended.permissions.size).toBe(0);

		await expect(setMemberStatus(db, created.id, OWNER, 'suspended')).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});
});

describe('browse visibility', () => {
	// THE WHOLE BROWSE RULE is now `visibility = 'public'`. It used to be one half
	// of a two-axis test, and the other axis no longer exists — so a group is
	// either listed or it is private, with nothing in between to get wrong.
	it('shows anonymous callers public groups and never a private one', async () => {
		await group({ name: 'Open', groupDid: 'did:plc:a' });
		await group({ name: 'Secret', groupDid: 'did:plc:d', visibility: 'private' });

		const anonymous = await listGroups(db, { callerDid: null });
		expect(anonymous.map((g) => g.name)).toEqual(['Open']);
	});

	// The bounded exception to the rule above: a caller sees their own and their
	// joined groups whatever their visibility, because a private group that is
	// invisible to its own members has nowhere to be reached from.
	it('adds the caller own and joined groups even when private', async () => {
		const secret = await group({ name: 'Secret', groupDid: 'did:plc:d', visibility: 'private' });
		await addMember(db, secret.id, ALICE, 'member');

		expect((await listGroups(db, { callerDid: OWNER })).map((g) => g.name)).toEqual(['Secret']);
		expect((await listGroups(db, { callerDid: ALICE })).map((g) => g.name)).toEqual(['Secret']);
		expect((await listGroups(db, { callerDid: BOB })).map((g) => g.name)).toEqual([]);
	});
});

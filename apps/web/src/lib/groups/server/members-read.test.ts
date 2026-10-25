// Reading the roster and the authz config back out of records, and the gate
// that decides from them.
//
// Two rules are tested here:
//
//   1. A DID with no membership record has no access, whatever its row says,
//      and neither does one whose record grants no role this build knows. Both
//      must answer the same way as a stranger; otherwise the gate lets in a
//      member the roster cannot explain.
//   2. The records-derived roster comes out in the same order the SQL gives
//      (by join time), or switching source reshuffles a page.
//
// Rebuilding the D1 projection from these records is tested in ./rebuild.test.ts.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import { pdsSpaceReader } from './about-read';
import { hostDown, spaceReader, type SpaceRecordInput } from './__fixtures__/space-reader';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	NO_MEMBER_RECORDS,
	creatorDidFromRecords,
	effectivePermissions,
	hasAuthzRecords,
	hasMemberRecords,
	readCallerAuthz,
	readGroupMembers,
	resolveActor,
	rosterFromRecords,
	rosterFromRows
} from './members-read';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupAccessRecord,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord
} from '../members-record';
import {
	DEFAULT_ROLE_PERMISSIONS,
	PUBLISHED_SCOPES,
	publishedScopes,
	type GroupPermission,
	type GroupRoleName
} from '../permissions';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';

import { spaceUri } from '../ids';
import { listMembers } from './db/roster';
import { getCallerMembership } from './standing';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

/** A reader over records in the group's members space. */
const readerOver = (records: SpaceRecordInput[]) =>
	spaceReader(GROUP_DID, { space: MEMBERS, records });

function membership(did: string, roles: string[], createdAt: string): SpaceRecordInput {
	return {
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did,
		value: {
			...groupMembershipRecord({ subject: did, roles: roles as never, createdAt }),
			$type: GROUP_MEMBERSHIP_COLLECTION
		}
	};
}

const accessRecord: SpaceRecordInput = {
	collection: GROUP_ACCESS_COLLECTION,
	rkey: GROUP_ACCESS_RKEY,
	value: {
		...groupAccessRecord({
			spaceType: 'group.opensocial.members',
			roles: ['admin', 'member'],
			public: false
		}),
		$type: GROUP_ACCESS_COLLECTION
	}
};

/** The authz config a create writes: one `role` record per seeded role, and
 *  the two binding records over the seeded bundles. */
function roleRecord(role: GroupRoleName): SpaceRecordInput {
	return {
		collection: GROUP_ROLE_COLLECTION,
		rkey: role,
		value: { ...groupRoleRecord({ id: role }), $type: GROUP_ROLE_COLLECTION }
	};
}

function bindingsRecord(
	altitude: 'community' | 'modality',
	bundles: Partial<Record<GroupRoleName, readonly GroupPermission[]>> = DEFAULT_ROLE_PERMISSIONS
): SpaceRecordInput {
	const collection =
		altitude === 'community' ? GROUP_PERMISSIONS_COLLECTION : GROUP_EVENT_PERMISSIONS_COLLECTION;
	return {
		collection,
		rkey: GROUP_PERMISSIONS_RKEY,
		value: { ...groupBindingsRecord({ altitude, bundles }), $type: collection }
	};
}

const AUTHZ: SpaceRecordInput[] = [
	roleRecord('admin'),
	roleRecord('member'),
	bindingsRecord('community'),
	bindingsRecord('modality')
];

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	}));
});

afterEach(() => harness.close());

describe('readGroupMembers', () => {
	it('reads the memberships and the access record out of the members space', async () => {
		const members = await readGroupMembers(
			readerOver([
				accessRecord,
				membership(OWNER, ['admin'], '2026-09-01T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);

		expect(members.memberships.map((m) => m.subject)).toEqual([OWNER, ADMIN]);
		expect(members.access?.roles).toEqual(['admin', 'member']);
		expect(members.memberships[0].uri).toBe(
			`${MEMBERS}/${GROUP_DID}/${GROUP_MEMBERSHIP_COLLECTION}/${OWNER}`
		);
	});

	it('is empty rather than an error for a group whose space holds nothing', async () => {
		const members = await readGroupMembers(readerOver([]), group);
		expect(members).toEqual(NO_MEMBER_RECORDS);
		expect(hasMemberRecords(members)).toBe(false);
		// An absent authz config is not a group that grants nothing: the gate has
		// to be able to tell "not written yet" from "bound to nothing".
		expect(hasAuthzRecords(members)).toBe(false);
	});
});

describe('the authz config as records', () => {
	it('reads the roles, the permissions grants as written, and the event bindings', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);

		expect(members.roles.map((role) => role.id)).toEqual(['admin', 'member']);
		expect(hasAuthzRecords(members)).toBe(true);
		// `permissions` stays scopes: the gate evaluates them, and no name is read
		// off the record.
		expect(members.permissions?.find((grant) => grant.role === 'admin')).toEqual({
			role: 'admin',
			scopes: publishedScopes(DEFAULT_ROLE_PERMISSIONS.admin),
			assignable: ['admin', 'member']
		});
		expect(members.eventPermissions?.bindings.find((b) => b.role === 'admin')?.permissions).toEqual(
			['MANAGE_EVENTS', 'CREATE_EVENT']
		);
	});

	it('unions the two records into one effective grant', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);

		// The case the two-record split can get wrong quietly: reading only
		// `permissions` leaves an admin who may configure the group but may not
		// create its events.
		expect([...effectivePermissions(members, ['admin'], GROUP_DID)].sort()).toEqual([
			'ADMIT_MEMBERS',
			'ASSIGN_ROLES',
			'CREATE_EVENT',
			'EJECT_MEMBERS',
			'MANAGE_EVENTS',
			'MANAGE_GROUP'
		]);
		// A member is bound at both altitudes and holds nothing at either, which
		// is the seeded model rather than a missing record.
		expect([...effectivePermissions(members, ['member'], GROUP_DID)]).toEqual([]);
		expect(members.permissions?.map((grant) => grant.role)).toEqual(['admin', 'member']);
	});

	it('grants nothing for a role the caller does not hold, and nothing with no records', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);
		expect([...effectivePermissions(members, [], GROUP_DID)]).toEqual([]);
		expect([...effectivePermissions(NO_MEMBER_RECORDS, ['admin'], GROUP_DID)]).toEqual([]);
	});

	it('drops an event action or an unknown scope in the permissions record', async () => {
		// A `permissions` grant naming the modality action is not a grant in the
		// wrong place: only scopes grant anything there, so it resolves to nothing
		// rather than to CREATE_EVENT.
		const members = await readGroupMembers(
			readerOver([
				{
					collection: GROUP_PERMISSIONS_COLLECTION,
					rkey: GROUP_PERMISSIONS_RKEY,
					value: {
						$type: GROUP_PERMISSIONS_COLLECTION,
						grants: [
							{
								role: 'member',
								scopes: ['createEvent', 'takedown', ...PUBLISHED_SCOPES.ADMIT_MEMBERS],
								assignable: ['member']
							}
						]
					}
				}
			]),
			group
		);

		expect([...effectivePermissions(members, ['member'], GROUP_DID)]).toEqual(['ADMIT_MEMBERS']);
	});
});

describe('creatorDidFromRecords', () => {
	it('is the earliest admin, a member never, and the DID breaks a tie', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(MEMBER, ['member'], '2026-09-01T10:00:00.000Z'),
				membership(OWNER, ['admin'], '2026-09-02T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-03T10:00:00.000Z')
			]),
			group
		);
		expect(creatorDidFromRecords(members)).toBe(OWNER);

		const tied = await readGroupMembers(
			readerOver([
				membership(OWNER, ['admin'], '2026-09-02T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);
		expect(creatorDidFromRecords(tied)).toBe([OWNER, ADMIN].sort()[0]);
	});

	it('puts an admin record with no usable date after every dated one', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(OWNER, ['admin'], 'not-a-date'),
				membership(ADMIN, ['admin'], '2026-09-03T10:00:00.000Z')
			]),
			group
		);
		expect(members.memberships.map((record) => record.subject)).toContain(OWNER);
		expect(creatorDidFromRecords(members)).toBe(ADMIN);
	});

	it('is null when no record grants admin', async () => {
		const members = await readGroupMembers(
			readerOver([membership(MEMBER, ['member'], '2026-09-01T10:00:00.000Z')]),
			group
		);
		expect(creatorDidFromRecords(members)).toBeNull();
	});
});

describe('rosterFromRecords', () => {
	// No owner: the creator sorts by join time like anyone.
	it('orders the roster exactly as the SQL does: by join time, the creator included', async () => {
		const joined = {
			[MEMBER]: '2026-09-03T10:00:00.000Z',
			[OWNER]: '2026-09-05T10:00:00.000Z',
			[ADMIN]: '2026-09-02T10:00:00.000Z'
		};
		const members = await readGroupMembers(
			readerOver([
				membership(MEMBER, ['member'], joined[MEMBER]),
				membership(OWNER, ['admin'], joined[OWNER]),
				membership(ADMIN, ['admin'], joined[ADMIN])
			]),
			group
		);
		for (const [did, at] of Object.entries(joined)) {
			harness.raw
				.prepare('UPDATE memberships SET created_at = ? WHERE did = ?')
				.run(Date.parse(at), did);
		}
		// The creator joined last here, so they come last.
		expect(rosterFromRecords(members).map((entry) => entry.did)).toEqual([ADMIN, MEMBER, OWNER]);
		expect(rosterFromRows(await listMembers(db, group.id)).map((entry) => entry.did)).toEqual([
			ADMIN,
			MEMBER,
			OWNER
		]);
	});

	it('drops a record that grants no known role instead of rendering it role-less', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(OWNER, ['admin'], '2026-09-01T10:00:00.000Z'),
				membership(STRANGER, ['greeter'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);
		expect(rosterFromRecords(members).map((entry) => entry.did)).toEqual([OWNER]);
	});

	it('projects a multi-role record onto its most privileged role', async () => {
		const members = await readGroupMembers(
			readerOver([membership(ADMIN, ['member', 'admin'], '2026-09-02T10:00:00.000Z')]),
			group
		);
		expect(rosterFromRecords(members)[0].role).toBe('admin');
	});
});

// The roster is the membership records. An acceptance decides only how a member
// is shown, and never lists anyone on its own.
describe('the roster, with acceptances', () => {
	async function twoMembers() {
		return readGroupMembers(
			readerOver([
				membership(OWNER, ['admin'], '2026-09-01T10:00:00.000Z'),
				membership(MEMBER, ['member'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);
	}

	it('does not list a DID that has an acceptance and no membership', async () => {
		const roster = rosterFromRecords(
			await twoMembers(),
			new Map([
				[MEMBER, true],
				[STRANGER, true]
			])
		);
		expect(roster.map((entry) => entry.did)).toEqual([OWNER, MEMBER]);
	});
});

// The gate resolves from records. `resolveActorPermissions` is the pure half
// (records in, a set out), and `getCallerMembership` is the loader that reads
// them and owns the policy: no cache, an unreadable space fails closed, and
// only a readable space with no config falls back to the rows. The cases below
// run against a D1 whose rows disagree with the records on purpose, so it is
// visible which one the gate believed.
describe('the gate, from records', () => {
	const sorted = (set: ReadonlySet<string>) => [...set].sort();
	const ALL = [...DEFAULT_ROLE_PERMISSIONS.admin].sort();

	it('is a pure function of the records: the union across both binding records', async () => {
		const members = await readGroupMembers(
			readerOver([...AUTHZ, membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')]),
			group
		);
		expect(sorted(resolveActor(members, ADMIN, GROUP_DID).permissions)).toEqual(ALL);
		expect(resolveActor(members, STRANGER, GROUP_DID).permissions.size).toBe(0);
		expect(resolveActor(members, null, GROUP_DID).permissions.size).toBe(0);
	});

	it('reads one membership by key, not the roster', async () => {
		const members = await readCallerAuthz(
			readerOver([
				...AUTHZ,
				membership(OWNER, ['admin'], '2026-09-01T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
			]),
			group,
			ADMIN
		);
		expect(members.memberships.map((m) => m.subject)).toEqual([ADMIN]);
		expect(hasAuthzRecords(members)).toBe(true);
	});

	it('changes the NEXT decision when a binding record is edited, with no D1 write', async () => {
		const record = membership(MEMBER, ['member'], '2026-09-03T10:00:00.000Z');
		const before = await getCallerMembership(db, group, MEMBER, readerOver([...AUTHZ, record]));
		expect(before.permissions.size).toBe(0);

		// Only the eventPermissions record changes: members may now post events.
		const edited = [
			...AUTHZ.filter((r) => r.collection !== GROUP_EVENT_PERMISSIONS_COLLECTION),
			bindingsRecord('modality', { ...DEFAULT_ROLE_PERMISSIONS, member: ['CREATE_EVENT'] }),
			record
		];
		const after = await getCallerMembership(db, group, MEMBER, readerOver(edited));
		expect(sorted(after.permissions)).toEqual(['CREATE_EVENT']);
		// The row still says what it said: the records decided.
		expect(after.role).toBe('member');
	});

	it('grants nothing to a role bound to nothing', async () => {
		const unbound = [
			roleRecord('admin'),
			roleRecord('member'),
			bindingsRecord('community', { admin: [], member: [] }),
			bindingsRecord('modality', { admin: [], member: [] }),
			membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
		];
		const admin = await getCallerMembership(db, group, ADMIN, readerOver(unbound));
		// The row still binds admin to everything; the records win.
		expect(admin.permissions.size).toBe(0);
	});

	it('grants nothing to a DID whose row says admin but who has no membership record', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, readerOver(AUTHZ));
		expect(admin.role).toBe('admin');
		expect(admin.permissions.size).toBe(0);
	});

	// The read gate asks the same records. The state below is a revocation whose
	// record delete succeeded and whose row delete did not. If `onRoster` read the
	// row, that DID could still open a private group.
	it('puts a DID with a row but no membership record OFF the roster', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, readerOver(AUTHZ));
		expect(admin.onRoster).toBe(false);
	});

	it('puts a DID with a membership record ON the roster, whatever the row says', async () => {
		const record = membership(STRANGER, ['member'], '2026-09-04T10:00:00.000Z');
		const joined = await getCallerMembership(db, group, STRANGER, readerOver([...AUTHZ, record]));
		expect(joined.role).toBeNull();
		expect(joined.onRoster).toBe(true);
	});

	it('takes the roster from the row in both fallback cases, and nobody else is on it', async () => {
		// Readable, no config yet: the rows are what the group was created with.
		expect((await getCallerMembership(db, group, ADMIN, readerOver([]))).onRoster).toBe(true);
		// No credential, so no reader: the row answers the read, while the
		// permission half still grants nothing. A space that errors is a
		// different case, and `readStanding` puts nobody on the roster for it.
		const unreadable = await getCallerMembership(db, group, ADMIN, null);
		expect(unreadable.onRoster).toBe(true);
		expect(unreadable.permissions.size).toBe(0);
		expect((await getCallerMembership(db, group, STRANGER, null)).onRoster).toBe(false);
	});

	// The rows never decide what a member may do: a group with no config grants
	// nobody anything, and the row still says who is on the roster. (Spec: FR-213.)
	it('grants nothing from the rows when the space holds no config', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, readerOver([]));
		expect(admin.permissions.size).toBe(0);
		expect(admin.grants.anywhere).toEqual([]);
		expect(admin.onRoster).toBe(true);
		// A group with no members space at all is the same case.
		const noSpace = await getCallerMembership(
			db,
			{ ...group, members_space_uri: null },
			ADMIN,
			null
		);
		expect(noSpace.permissions.size).toBe(0);
	});

	// The group's own account is the member with every permission, and needs no
	// record and no row. It is how a group with no admin left recovers.
	it('gives the group DID itself every permission, with nothing read', async () => {
		const reader = readerOver([]);
		const itself = await getCallerMembership(db, group, GROUP_DID, reader);
		expect(sorted(itself.permissions)).toEqual(ALL);
		expect(itself.grants.group).toBe(true);
		expect(itself.onRoster).toBe(true);
		expect(reader.calls).toEqual([]);
	});

	it('fails closed when the space cannot be read', async () => {
		const down = spaceReader(GROUP_DID, { fail: hostDown(502) });
		await expect(getCallerMembership(db, group, ADMIN, down)).rejects.toThrow(/502/);
		// No credential for a group that has a members space: nothing, not rows.
		const noReader = await getCallerMembership(db, group, ADMIN, null);
		expect(noReader.permissions.size).toBe(0);
	});

	// The same case through the live reader rather than a fake one. The row says
	// ADMIN is an admin, and the PDS answers every members-space read with a 400
	// that is not RecordNotFound. A reader that took that 400 for "no records"
	// would find no config and hand the decision to the row: an admin's
	// permissions for a caller the records may have removed.
	it('fails closed when the PDS refuses a space read with a 400', async () => {
		vi.stubGlobal('fetch', async () =>
			Response.json({ error: 'SpaceNotFound', message: 'Space not found' }, { status: 400 })
		);
		try {
			const reader = pdsSpaceReader(linkedCredential(GROUP_DID), GROUP_DID);
			await expect(getCallerMembership(db, group, ADMIN, reader)).rejects.toThrow(
				/failed: 400 SpaceNotFound/
			);
		} finally {
			vi.unstubAllGlobals();
			unlinkAllGroups();
		}
	});

	it('reads nothing for an anonymous caller', async () => {
		const reader = readerOver(AUTHZ);
		const anonymous = await getCallerMembership(db, group, null, reader);
		expect(anonymous.permissions.size).toBe(0);
		expect(reader.calls).toEqual([]);
	});
});

// Reading the roster back out of records, and rebuilding the D1 projection
// from them.
//
// Four rules are tested here:
//
//   1. A DID with no membership record has no access, and neither does one
//      whose record grants no role this build knows. Both must answer the same
//      way as a stranger; otherwise the gate lets in a member the roster cannot
//      explain.
//   2. The records-derived roster comes out in the same order the SQL gives
//      (`is_owner DESC, created_at ASC`), or switching source reshuffles a page.
//   3. The rebuild is additive. A roster row with no record is the trace of a
//      roster act whose second half failed (`roster.ts`), and the gate already
//      denies it. A rebuild that deleted unmatched rows would be guessing which
//      failure each one is.
//   4. The owner's row is immutable in SQL, so the rebuild inserts a missing
//      one and does not fight one that disagrees.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	addMember,
	createGroup,
	getCallerMembership,
	listMembers,
	recordGroupSpaces
} from './repo';
import type { GroupSpaceReader } from './about-read';
import {
	NO_MEMBER_RECORDS,
	effectivePermissions,
	hasAuthzRecords,
	hasMemberRecords,
	hasRecordedAccess,
	ownerDidFromRecords,
	readCallerAuthz,
	readGroupMembers,
	rebuildGroupMembers,
	resolveActorPermissions,
	rolesForDid,
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
import { DEFAULT_ROLE_PERMISSIONS, type GroupPermission, type GroupRoleName } from '../permissions';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

interface SpaceFixture {
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

/** A reader over a fixed record set, addressed the way a space addresses them:
 *  `<space>/<repo>/<collection>/<rkey>`. `listRecords` returns no `uri` on the
 *  wire, so the fixture supplies the fields and lets the reader rebuild it. */
function readerOver(records: SpaceFixture[]): GroupSpaceReader {
	const all = records.map((record) => ({
		uri: `${MEMBERS}/${GROUP_DID}/${record.collection}/${record.rkey}`,
		cid: 'bafytest',
		collection: record.collection,
		rkey: record.rkey,
		value: record.value
	}));
	return {
		async get(query) {
			return all.find((r) => r.collection === query.collection && r.rkey === query.rkey) ?? null;
		},
		async list(query) {
			return all.filter((r) => !query.collection || r.collection === query.collection);
		}
	};
}

function membership(did: string, roles: string[], createdAt: string): SpaceFixture {
	return {
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did,
		value: {
			...groupMembershipRecord({ subject: did, roles: roles as never, createdAt }),
			$type: GROUP_MEMBERSHIP_COLLECTION
		}
	};
}

const accessRecord: SpaceFixture = {
	collection: GROUP_ACCESS_COLLECTION,
	rkey: GROUP_ACCESS_RKEY,
	value: {
		...groupAccessRecord({ roles: ['owner', 'admin', 'member'] }),
		$type: GROUP_ACCESS_COLLECTION
	}
};

/** The authz config a create writes: one `role` record per seeded role, and
 *  the two binding records over the seeded bundles. */
function roleRecord(role: GroupRoleName): SpaceFixture {
	return {
		collection: GROUP_ROLE_COLLECTION,
		rkey: role,
		value: { ...groupRoleRecord({ id: role }), $type: GROUP_ROLE_COLLECTION }
	};
}

function bindingsRecord(
	altitude: 'community' | 'modality',
	bundles: Partial<Record<GroupRoleName, readonly GroupPermission[]>> = DEFAULT_ROLE_PERMISSIONS
): SpaceFixture {
	const collection =
		altitude === 'community' ? GROUP_PERMISSIONS_COLLECTION : GROUP_EVENT_PERMISSIONS_COLLECTION;
	return {
		collection,
		rkey: GROUP_PERMISSIONS_RKEY,
		value: { ...groupBindingsRecord({ altitude, bundles }), $type: collection }
	};
}

const AUTHZ: SpaceFixture[] = [
	roleRecord('owner'),
	roleRecord('admin'),
	roleRecord('member'),
	bindingsRecord('community'),
	bindingsRecord('modality')
];

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');
	await recordGroupSpaces(db, group.id, { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };
});

afterEach(() => harness.close());

describe('readGroupMembers', () => {
	it('reads the memberships and the access record out of the members space', async () => {
		const members = await readGroupMembers(
			readerOver([
				accessRecord,
				membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);

		expect(members.memberships.map((m) => m.subject)).toEqual([OWNER, ADMIN]);
		expect(members.access?.roles).toEqual(['owner', 'admin', 'member']);
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

	it('reads nothing when the group has no members space yet', async () => {
		const members = await readGroupMembers(readerOver([accessRecord]), {
			...group,
			members_space_uri: null
		});
		expect(members.access).toBeNull();
	});
});

describe('the authz config as records', () => {
	it('reads the roles and both binding records back in our own vocabulary', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);

		expect(members.roles.map((role) => role.id)).toEqual(['owner', 'admin', 'member']);
		expect(hasAuthzRecords(members)).toBe(true);
		// The record publishes the community standard's identifiers. The app
		// never sees them, because they are translated when the record is parsed.
		expect(members.permissions?.bindings.find((b) => b.role === 'admin')?.permissions).toEqual([
			'MANAGE_GROUP',
			'ADMIT_MEMBERS',
			'EJECT_MEMBERS',
			'ASSIGN_ROLES'
		]);
		expect(members.eventPermissions?.bindings.find((b) => b.role === 'admin')?.permissions).toEqual(
			['MANAGE_EVENTS', 'CREATE_EVENT']
		);
	});

	it('unions the two records into one effective grant', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);

		// The case the two-record split can get wrong quietly: reading only
		// `permissions` leaves an admin who may configure the group but may not
		// create its events.
		expect([...effectivePermissions(members, ['admin'])].sort()).toEqual([
			'ADMIT_MEMBERS',
			'ASSIGN_ROLES',
			'CREATE_EVENT',
			'EJECT_MEMBERS',
			'MANAGE_EVENTS',
			'MANAGE_GROUP'
		]);
		// A member is bound at both altitudes and holds nothing at either, which
		// is the seeded model rather than a missing record.
		expect([...effectivePermissions(members, ['member'])]).toEqual([]);
		expect(members.permissions?.bindings.map((b) => b.role)).toEqual(['owner', 'admin', 'member']);
	});

	it('grants nothing for a role the caller does not hold, and nothing with no records', async () => {
		const members = await readGroupMembers(readerOver(AUTHZ), group);
		expect([...effectivePermissions(members, [])]).toEqual([]);
		expect([...effectivePermissions(NO_MEMBER_RECORDS, ['owner'])]).toEqual([]);
	});

	it('drops an action published at the wrong altitude', async () => {
		// A `permissions` record naming the modality action is not a grant in the
		// wrong place: the community set is closed at four actions, so it
		// resolves to nothing rather than to CREATE_EVENT.
		const members = await readGroupMembers(
			readerOver([
				{
					collection: GROUP_PERMISSIONS_COLLECTION,
					rkey: GROUP_PERMISSIONS_RKEY,
					value: {
						$type: GROUP_PERMISSIONS_COLLECTION,
						bindings: [{ role: 'member', actions: ['createEvent', 'takedown', 'admit'] }],
						createdAt: '2026-09-20T10:00:00.000Z'
					}
				}
			]),
			group
		);

		expect(members.permissions?.bindings).toEqual([
			{ role: 'member', permissions: ['ADMIT_MEMBERS'] }
		]);
		expect([...effectivePermissions(members, ['member'])]).toEqual(['ADMIT_MEMBERS']);
	});
});

describe('access from records', () => {
	it('gives a DID with no membership record no access', async () => {
		const members = await readGroupMembers(
			readerOver([membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z')]),
			group
		);
		expect(hasRecordedAccess(members, STRANGER)).toBe(false);
		expect(rolesForDid(members, STRANGER)).toEqual([]);
	});

	it('gives a record granting no known role no access either', async () => {
		const members = await readGroupMembers(
			readerOver([membership(MEMBER, ['greeter'], '2026-09-01T10:00:00.000Z')]),
			group
		);
		expect(rolesForDid(members, MEMBER)).toEqual([]);
		expect(hasRecordedAccess(members, MEMBER)).toBe(false);
	});

	it('gives an anonymous caller no access', async () => {
		const members = await readGroupMembers(
			readerOver([membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z')]),
			group
		);
		expect(hasRecordedAccess(members, null)).toBe(false);
	});

	it('names the owner from the record that grants the owner role', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z'),
				membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z')
			]),
			group
		);
		expect(ownerDidFromRecords(members)).toBe(OWNER);
	});

	it('names no owner rather than guessing one when no record grants it', async () => {
		const members = await readGroupMembers(
			readerOver([membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')]),
			group
		);
		expect(ownerDidFromRecords(members)).toBeNull();
	});
});

describe('rosterFromRecords', () => {
	it('orders the roster exactly as the SQL does: owner first, then by join time', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(MEMBER, ['member'], '2026-09-03T10:00:00.000Z'),
				membership(OWNER, ['owner'], '2026-09-05T10:00:00.000Z'),
				membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
			]),
			group
		);
		// The owner joined last here, so a sort that only used the date would put
		// them at the end.
		expect(rosterFromRecords(members).map((entry) => entry.did)).toEqual([OWNER, ADMIN, MEMBER]);
		expect(rosterFromRows(await listMembers(db, group.id)).map((entry) => entry.did)).toEqual([
			OWNER,
			ADMIN,
			MEMBER
		]);
	});

	it('drops a record that grants no known role instead of rendering it role-less', async () => {
		const members = await readGroupMembers(
			readerOver([
				membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
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

	it('reports every recorded member as active: there is no suspension', async () => {
		const members = await readGroupMembers(
			readerOver([membership(MEMBER, ['member'], '2026-09-02T10:00:00.000Z')]),
			group
		);
		expect(rosterFromRecords(members)[0].status).toBe('active');
	});
});

describe('rebuildGroupMembers', () => {
	const fullSpace = () =>
		readerOver([
			accessRecord,
			membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
			membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z'),
			membership(MEMBER, ['member'], '2026-09-03T10:00:00.000Z')
		]);

	it('restores a dropped roster row from its record', async () => {
		await db
			.prepare(`DELETE FROM memberships WHERE group_id = ? AND did = ?`)
			.bind(group.id, ADMIN)
			.run();

		const result = await rebuildGroupMembers(db, fullSpace(), group);

		expect(result.restored).toEqual([ADMIN]);
		const roster = await listMembers(db, group.id);
		expect(roster.find((row) => row.did === ADMIN)).toMatchObject({
			role: 'admin',
			status: 'active',
			created_at: Date.parse('2026-09-02T10:00:00.000Z')
		});
	});

	it('restores the roster after every non-owner row is dropped', async () => {
		await db
			.prepare(`DELETE FROM memberships WHERE group_id = ? AND did <> ?`)
			.bind(group.id, OWNER)
			.run();
		expect(await listMembers(db, group.id)).toHaveLength(1);

		await rebuildGroupMembers(db, fullSpace(), group);

		expect(
			rosterFromRows(await listMembers(db, group.id)).map((e) => `${e.did}/${e.role}`)
		).toEqual([`${OWNER}/owner`, `${ADMIN}/admin`, `${MEMBER}/member`]);
	});

	it('corrects a row whose role drifted from its record', async () => {
		await db
			.prepare(
				`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE group_id = ? AND name = 'member')
				 WHERE group_id = ? AND did = ?`
			)
			.bind(group.id, group.id, ADMIN)
			.run();

		const result = await rebuildGroupMembers(db, fullSpace(), group);

		expect(result.restored).toEqual([ADMIN]);
		expect((await listMembers(db, group.id)).find((row) => row.did === ADMIN)?.role).toBe('admin');
	});

	it('is a no-op when the rows already agree, and says so', async () => {
		const result = await rebuildGroupMembers(db, fullSpace(), group);
		expect(result.restored).toEqual([]);
		expect(result.unchanged.sort()).toEqual([ADMIN, MEMBER, OWNER].sort());
		expect(result.orphans).toEqual([]);
	});

	it('reports a row with no record as an orphan and leaves the row', async () => {
		// A revocation whose row delete failed after its record went: the space
		// no longer names them, the row still does.
		const reader = readerOver([
			accessRecord,
			membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
			membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
		]);

		const result = await rebuildGroupMembers(db, reader, group);

		expect(result.orphans).toEqual([MEMBER]);
		expect((await listMembers(db, group.id)).some((row) => row.did === MEMBER)).toBe(true);
	});

	it('skips a record naming a role this group has no row for', async () => {
		await db
			.prepare(`DELETE FROM memberships WHERE group_id = ? AND did = ?`)
			.bind(group.id, ADMIN)
			.run();
		await db
			.prepare(`DELETE FROM roles WHERE group_id = ? AND name = 'admin'`)
			.bind(group.id)
			.run();

		const result = await rebuildGroupMembers(db, fullSpace(), group);

		expect(result.restored).not.toContain(ADMIN);
		expect(result.skipped).toEqual([{ did: ADMIN, reason: 'this group has no admin role row' }]);
	});

	it('refuses to fight the immutable owner row when a record disagrees with it', async () => {
		const reader = readerOver([
			accessRecord,
			// A record claiming the owner is merely an admin: the schema pins the
			// owner role to groups.owner_did, so this can only be reported.
			membership(OWNER, ['admin'], '2026-09-01T10:00:00.000Z')
		]);

		const result = await rebuildGroupMembers(db, reader, group);

		expect(result.skipped).toEqual([
			{ did: OWNER, reason: 'owner_did cannot hold the admin role' }
		]);
		expect((await listMembers(db, group.id)).find((row) => row.did === OWNER)?.role).toBe('owner');
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
	const ALL = [...DEFAULT_ROLE_PERMISSIONS.owner].sort();

	it('is a pure function of the records: the union across both binding records', async () => {
		const members = await readGroupMembers(
			readerOver([...AUTHZ, membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')]),
			group
		);
		expect(sorted(resolveActorPermissions(members, ADMIN))).toEqual(ALL);
		expect(resolveActorPermissions(members, STRANGER).size).toBe(0);
		expect(resolveActorPermissions(members, null).size).toBe(0);
	});

	it('reads one membership by key, not the roster', async () => {
		const members = await readCallerAuthz(
			readerOver([
				...AUTHZ,
				membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
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
			roleRecord('owner'),
			roleRecord('admin'),
			roleRecord('member'),
			bindingsRecord('community', { owner: [], admin: [], member: [] }),
			bindingsRecord('modality', { owner: [], admin: [], member: [] }),
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
		// A members space this deployment cannot read: the row answers the read,
		// while the permission half still grants nothing.
		const unreadable = await getCallerMembership(db, group, ADMIN, null);
		expect(unreadable.onRoster).toBe(true);
		expect(unreadable.permissions.size).toBe(0);
		expect((await getCallerMembership(db, group, STRANGER, null)).onRoster).toBe(false);
	});

	it('falls back to the rows only when the space is readable and holds no config', async () => {
		const admin = await getCallerMembership(db, group, ADMIN, readerOver([]));
		expect(sorted(admin.permissions)).toEqual(ALL);
		// A group with no members space at all is the same case.
		const noSpace = await getCallerMembership(
			db,
			{ ...group, members_space_uri: null },
			ADMIN,
			null
		);
		expect(sorted(noSpace.permissions)).toEqual(ALL);
	});

	it('fails closed when the space cannot be read', async () => {
		const down: GroupSpaceReader = {
			async get() {
				throw new Error('com.atproto.space.getRecord failed: 502');
			},
			async list() {
				throw new Error('com.atproto.space.listRecords failed: 502');
			}
		};
		await expect(getCallerMembership(db, group, ADMIN, down)).rejects.toThrow(/502/);
		// No credential for a group that has a members space: nothing, not rows.
		const noReader = await getCallerMembership(db, group, ADMIN, null);
		expect(noReader.permissions.size).toBe(0);
	});

	it('reads nothing for an anonymous caller', async () => {
		const reader: GroupSpaceReader = {
			async get() {
				throw new Error('an anonymous caller must not reach the PDS');
			},
			async list() {
				throw new Error('an anonymous caller must not reach the PDS');
			}
		};
		const anonymous = await getCallerMembership(db, group, null, reader);
		expect(anonymous.permissions.size).toBe(0);
	});
});

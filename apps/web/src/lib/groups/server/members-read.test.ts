// Reading the roster back out of records, and rebuilding the D1 projection
// from them.
//
// Four things here are rules rather than plumbing:
//
//   1. A DID with NO membership record has no access — and neither does one
//      whose record grants no role this build knows. Both must answer the same
//      way as a stranger, because the alternative is a member the gate lets in
//      and the roster cannot explain.
//   2. The records-derived roster must come out in the SAME order the SQL gives
//      (`is_owner DESC, created_at ASC`), or switching source visibly reshuffles
//      a page.
//   3. The rebuild is ADDITIVE. A roster row with no record is a suspended
//      member by construction (suspension revokes the record), so a rebuild
//      that deleted unmatched rows would eject suspended members to make the
//      numbers agree.
//   4. The owner's row is immutable in SQL, so the rebuild has to INSERT a
//      missing one and refuse to fight a disagreeing one.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	addMember,
	createGroup,
	listMembers,
	recordGroupSpaces,
	setMemberStatus
} from './repo';
import type { GroupSpaceReader } from './about-read';
import {
	hasMemberRecords,
	hasRecordedAccess,
	ownerDidFromRecords,
	readGroupMembers,
	rebuildGroupMembers,
	rolesForDid,
	rosterFromRecords,
	rosterFromRows
} from './members-read';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord,
	groupMembershipRecord
} from '../members-record';
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
			return (
				all.find((r) => r.collection === query.collection && r.rkey === query.rkey) ?? null
			);
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

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		slug: 'kona',
		status: 'published'
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
		expect(members).toEqual({ memberships: [], access: null });
		expect(hasMemberRecords(members)).toBe(false);
	});

	it('reads nothing when the group has no members space yet', async () => {
		const members = await readGroupMembers(readerOver([accessRecord]), {
			...group,
			members_space_uri: null
		});
		expect(members.access).toBeNull();
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
		// The owner joined LAST here, so a sort that only used the date would put
		// them in the middle.
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

	it('reports every recorded member as active: suspension revokes the record', async () => {
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
		await db.prepare(`DELETE FROM memberships WHERE group_id = ? AND did <> ?`).bind(group.id, OWNER).run();
		expect(await listMembers(db, group.id)).toHaveLength(1);

		await rebuildGroupMembers(db, fullSpace(), group);

		expect(rosterFromRows(await listMembers(db, group.id)).map((e) => `${e.did}/${e.role}`)).toEqual([
			`${OWNER}/owner`,
			`${ADMIN}/admin`,
			`${MEMBER}/member`
		]);
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

	it('reports a suspended member as an orphan and leaves the row suspended', async () => {
		await setMemberStatus(db, group.id, MEMBER, 'suspended');
		// Suspension revoked the record, so the space no longer names them.
		const reader = readerOver([
			accessRecord,
			membership(OWNER, ['owner'], '2026-09-01T10:00:00.000Z'),
			membership(ADMIN, ['admin'], '2026-09-02T10:00:00.000Z')
		]);

		const result = await rebuildGroupMembers(db, reader, group);

		expect(result.orphans).toEqual([MEMBER]);
		expect((await listMembers(db, group.id)).find((row) => row.did === MEMBER)?.status).toBe(
			'suspended'
		);
	});

	it('skips a record naming a role this group has no row for', async () => {
		await db
			.prepare(`DELETE FROM memberships WHERE group_id = ? AND did = ?`)
			.bind(group.id, ADMIN)
			.run();
		await db.prepare(`DELETE FROM roles WHERE group_id = ? AND name = 'admin'`).bind(group.id).run();

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

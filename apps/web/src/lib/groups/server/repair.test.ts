// The settings-page repair. The important cases are what it refuses to write:
// it copies the row into the records only where the row is certain. So these
// tests focus on where writing would be wrong: a non-owner row with no record
// (a failed grant looks the same as a failed removal), a record that disagrees
// with its row, and an authz config that is half there.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, getMemberRow, recordGroupSpaces } from './repo';
import { putGroupMembership, writeGroupAuthz } from './members-writer';
import { GroupPermissionError, type GroupRepoWrite, type GroupRepoWriter } from './event-writer';
import { readGroupMembers, hasAuthzRecords } from './members-read';
import { describeRepair, repairGroup } from './repair';
import type { GroupRebuildSources } from './rebuild';
import type { GroupSpaceReader } from './about-read';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION
} from '../members-record';
import { spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;
let reader: GroupSpaceReader;
let sources: GroupRebuildSources;
const env = {};

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await recordGroupSpaces(db, group.id, { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return { uri: `${write.space}/${write.repo}/${write.collection}/${write.rkey}`, cid: 'bafy' };
	};
	// The latest write per (space, collection, rkey) wins, and a delete removes,
	// so the gate and the rebuild both read the space the test is writing into.
	const live = (space: string, collection?: string) => {
		const current = new Map<string, GroupRepoWrite>();
		for (const w of writes) {
			if (w.space !== space || (collection && w.collection !== collection)) continue;
			current.set(`${w.collection}/${w.rkey}`, w);
		}
		return [...current.values()]
			.filter((w) => w.intent !== 'delete')
			.map((w) => ({
				uri: `${w.space}/${w.repo}/${w.collection}/${w.rkey}`,
				cid: 'bafy',
				collection: w.collection,
				rkey: w.rkey,
				value: w.record
			}));
	};
	reader = {
		async get(q) {
			return live(q.space, q.collection).find((r) => r.rkey === q.rkey) ?? null;
		},
		async list(q) {
			return live(q.space, q.collection);
		}
	};
	sources = { reader, declared: async () => true };
});

afterEach(() => harness.close());

const repair = (callerDid: string | null = OWNER) =>
	repairGroup({ db, env, group, callerDid, writer, reader, sources });

const wroteTo = (collection: string) => writes.filter((w) => w.collection === collection);

describe('repairGroup', () => {
	// A create interrupted after the INSERT: a row and an empty members space.
	it("completes an interrupted create: access, the owner's membership, then the authz config", async () => {
		const result = await repair();

		expect(result.wrote).toEqual({ access: true, ownerMembership: true, authz: true });
		expect(result.unrecordedMembers).toEqual([]);
		expect(result.authzHeldBack).toBeNull();
		expect(describeRepair(result)).toMatch(
			/^Wrote the missing owner's membership record, access record and permission config\. /
		);
		// The config goes last: once it exists the gate reads records, so the
		// owner's record must already be there.
		const order = writes.map((w) => w.collection);
		expect(order.indexOf(GROUP_ACCESS_COLLECTION)).toBeLessThan(
			order.indexOf(GROUP_MEMBERSHIP_COLLECTION)
		);
		expect(order.indexOf(GROUP_MEMBERSHIP_COLLECTION)).toBeLessThan(
			order.indexOf(GROUP_ROLE_COLLECTION)
		);
		const members = await readGroupMembers(reader, group);
		expect(hasAuthzRecords(members)).toBe(true);
		expect(members.memberships.map((m) => [m.subject, m.roles])).toEqual([[OWNER, ['owner']]]);
	});

	it('writes nothing the second time', async () => {
		await repair();
		const before = writes.length;
		const again = await repair();
		expect(writes).toHaveLength(before);
		expect(again.wrote).toEqual({ access: false, ownerMembership: false, authz: false });
	});

	// A later member's record exists, the owner's does not, and there is no
	// authz config.
	it("writes the owner's missing record when another member's exists", async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			subject: MEMBER,
			roles: ['member'],
			intent: 'admit'
		});
		const memberWrites = wroteTo(GROUP_MEMBERSHIP_COLLECTION).length;

		const result = await repair();

		expect(result.wrote).toEqual({ access: true, ownerMembership: true, authz: true });
		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION)).toHaveLength(memberWrites + 1);
		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION).at(-1)?.rkey).toBe(OWNER);
	});

	// A failed admission and a failed removal leave the same row, so the row
	// cannot say which one happened, and the config would strip the member.
	it('never writes a non-owner row that has no record, and holds the config back', async () => {
		await addMember(db, group.id, MEMBER, 'member');

		const result = await repair();

		expect(result.unrecordedMembers).toEqual([MEMBER]);
		expect(result.wrote).toEqual({ access: true, ownerMembership: true, authz: false });
		expect(result.authzHeldBack).toBe('unrecorded-members');
		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION).map((w) => w.rkey)).toEqual([OWNER]);
		expect(wroteTo(GROUP_PERMISSIONS_COLLECTION)).toHaveLength(0);
		// And the rebuild leaves the row alone rather than deleting it.
		expect(await getMemberRow(db, group.id, MEMBER)).not.toBeNull();
		expect(describeRepair(result)).toContain('1 member has no membership record');
	});

	it('leaves a record that disagrees with its row as it is, and the rebuild follows the record', async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			subject: MEMBER,
			roles: ['admin'],
			intent: 'admit'
		});

		await repair();

		const memberRecords = wroteTo(GROUP_MEMBERSHIP_COLLECTION).filter((w) => w.rkey === MEMBER);
		expect(memberRecords).toHaveLength(1);
		expect((await getMemberRow(db, group.id, MEMBER))?.role).toBe('admin');
	});

	// A create that failed partway through the config: the owner's record went,
	// then the roles and community bindings, and the event bindings did not.
	it('does not complete a half-present authz config', async () => {
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			subject: OWNER,
			roles: ['owner'],
			intent: 'admit'
		});
		await writeGroupAuthz({ db, env, group, callerDid: OWNER, writer, reader });
		writes = writes.filter((w) => w.collection !== GROUP_EVENT_PERMISSIONS_COLLECTION);
		const permissionsBefore = wroteTo(GROUP_PERMISSIONS_COLLECTION).length;

		const result = await repair();

		expect(result.authzHeldBack).toBe('partial');
		expect(result.wrote.authz).toBe(false);
		expect(wroteTo(GROUP_PERMISSIONS_COLLECTION)).toHaveLength(permissionsBefore);
	});

	it("publishes the group's own bundles from its rows, not the seeded defaults", async () => {
		await db
			.prepare(
				`DELETE FROM role_permissions WHERE permission = 'ASSIGN_ROLES'
				 AND role_id = (SELECT id FROM roles WHERE group_id = ? AND name = 'admin')`
			)
			.bind(group.id)
			.run();

		await repair();

		const members = await readGroupMembers(reader, group);
		const admin = members.permissions?.bindings.find((b) => b.role === 'admin');
		expect(admin?.permissions).not.toContain('ASSIGN_ROLES');
		expect(admin?.permissions).toContain('ADMIT_MEMBERS');
	});

	it('refuses a caller without MANAGE_GROUP and writes nothing', async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await expect(repair(MEMBER)).rejects.toBeInstanceOf(GroupPermissionError);
		await expect(repair(null)).rejects.toBeInstanceOf(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

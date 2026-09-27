// The settings-page repair. The important cases are what it refuses to write:
// it copies the row into the records only where the row is certain. So these
// tests focus on where writing would be wrong: a non-owner row with no record
// (a failed grant looks the same as a failed removal), a record that disagrees
// with its row, and an authz config that is half there.
//
// It also brings the about space's member list in line with the membership
// records. The list lives at the host, so every case runs against the fake
// host (./__fixtures__/stub-pds.ts) with the group's credential stored, and
// the host pages its listings small enough that a second page is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './__fixtures__/stub-pds';
import { addMember, createGroup, getMemberRow, recordGroupSpaces } from './repo';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './members-writer';
import { GroupPermissionError, type GroupRepoWrite, type GroupRepoWriter } from './event-writer';
import { readGroupMembers, hasAuthzRecords } from './members-read';
import { describeRepair, repairGroup } from './repair';
import type { GroupRebuildSources } from './rebuild';
import { pdsSpaceReader, type GroupSpaceReader } from './about-read';
import { storeGroupCredential, type GroupCredential } from './credentials';
import { clearGroupSessions } from './session';
import { pdsProvisioner, provisionGroupSpaces } from './spaces';
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

/** 32 bytes, base64: the credential store accepts nothing shorter. */
const KEY = btoa('0123456789abcdef0123456789abcdef');
const CRED: GroupCredential = {
	service: 'https://pds.stub.test',
	identifier: 'kona.group.stub.test',
	password: 'app-pass-1234'
};

const MEMBER_LIST_METHODS = new Set([
	'com.atproto.simplespace.putMember',
	'com.atproto.simplespace.removeMember',
	'com.atproto.simplespace.listMembers'
]);

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;
let reader: GroupSpaceReader;
let sources: GroupRebuildSources;
let pds: ReturnType<typeof stubPds>;
/** Set by a case to answer one host call its own way. */
let failHost: StubPdsOptions['fail'] | null;
const env = { GROUP_CREDENTIAL_KEY: KEY };

/** A member-list call, by the space and the DID it names. A query carries them
 *  as parameters, a procedure in its body. */
function memberListCalls() {
	return pds.requests
		.filter((r) => MEMBER_LIST_METHODS.has(r.nsid))
		.map((r) => ({
			nsid: r.nsid,
			space: (r.body?.space as string | undefined) ?? r.params.space,
			did: r.body?.did as string | undefined
		}));
}

const memberListWrites = () =>
	memberListCalls().filter((c) => c.nsid !== 'com.atproto.simplespace.listMembers');

/** Changes a space's member list at the host directly, the way the group's
 *  owner could from any client, so a case can set up a list that drifted. */
async function hostList(method: 'putMember' | 'removeMember', space: string, did: string) {
	const res = await fetch(`${CRED.service}/xrpc/com.atproto.simplespace.${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(
			method === 'putMember' ? { space, did, read: true, write: false } : { space, did }
		)
	});
	expect(res.ok).toBe(true);
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	clearGroupSessions();
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });

	// The host pages two at a time, so any listing of three or more has a second
	// page that a one-call read would miss.
	failHost = null;
	pds = stubPds({
		did: GROUP_DID,
		handle: CRED.identifier,
		recordPageSize: 2,
		memberPageSize: 2,
		fail: (nsid, init, query) => failHost?.(nsid, init, query)
	});
	await storeGroupCredential(env, db, GROUP_DID, CRED);
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public');
	expect(uris).toEqual({ aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });
	await recordGroupSpaces(db, group.id, uris);
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };
	pds.clearLog();

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
		},
		// A space's configuration is the host's, not a record, so it comes from
		// the fake host.
		getSpace: (space) => pdsSpaceReader(CRED, GROUP_DID).getSpace(space)
	};
	sources = { reader, declared: async () => true };
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearGroupSessions();
	harness.close();
});

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

// The about space's member list is read access at the host, so Repair makes it
// equal the set of DIDs that hold a membership record: never the rows, which
// cannot tell a failed admission from a failed removal. These cases run the
// real transports end to end: the records, the reader and the list all go
// through the group's stored credential to the fake host.
describe('the about space member list follows the membership records', () => {
	const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
	// Sorted by DID, the host's order: the stranger lands on the first page of
	// the list and the extra on the second.
	const STRANGER = 'did:plc:aaaastrangeraaaaaaaaaaaa';
	const PAGE_TWO_EXTRA = 'did:plc:zzzzpagetwoextrazzzzzzzz';
	const ROSTER = [OWNER, ADMIN, MEMBER].sort();

	/** Repair with nothing injected but where the rebuild reads, which is the
	 *  same reader it would build (the declaration probe is not under test). */
	const realRepair = () =>
		repairGroup({
			db,
			env,
			group,
			callerDid: OWNER,
			sources: { reader: pdsSpaceReader(CRED, GROUP_DID), declared: async () => true }
		});

	// A complete group: owner, admin and member rows with a membership record
	// each, the access record and the authz config, and the list already
	// holding all three.
	beforeEach(async () => {
		await addMember(db, group.id, ADMIN, 'admin');
		await addMember(db, group.id, MEMBER, 'member');
		const seed = { db, env, group, callerDid: OWNER };
		await writeGroupAccess(seed);
		for (const [subject, role] of [
			[OWNER, 'owner'],
			[ADMIN, 'admin'],
			[MEMBER, 'member']
		] as const) {
			await putGroupMembership({ ...seed, subject, roles: [role], intent: 'admit' });
		}
		await writeGroupAuthz(seed);
		for (const did of ROSTER) await hostList('putMember', ABOUT, did);
		pds.clearLog();
	});

	it('repair makes the about space list equal the membership records', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, STRANGER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		pds.clearLog();

		await realRepair();

		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(pds.members(ABOUT).every((m) => m.read && !m.write)).toBe(true);
		expect(memberListCalls().filter((c) => c.did === GROUP_DID || c.space !== ABOUT)).toEqual([]);
		expect(pds.listed(MEMBERS)).toEqual([]);
	});

	it('a second repair makes no member-list write', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		await realRepair();
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		pds.clearLog();

		await realRepair();

		expect(memberListWrites()).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
	});

	// A failed admission and a failed removal leave the same row, so a row with
	// no record is never put on the list, just as it is never written a record.
	it('repair never lists a member whose row has no membership record', async () => {
		const UNRECORDED = 'did:plc:unrecordedaaaaaaaaaaaaaa';
		await addMember(db, group.id, UNRECORDED, 'member');
		await hostList('removeMember', ABOUT, MEMBER);
		pds.clearLog();

		const result = await realRepair();

		expect(result.unrecordedMembers).toEqual([UNRECORDED]);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(memberListWrites().map((c) => c.did)).toEqual([MEMBER]);
	});

	it('repair never puts or removes the group’s own DID', async () => {
		await hostList('putMember', ABOUT, GROUP_DID);
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();

		await realRepair();

		expect(pds.listed(ABOUT)).toEqual([...ROSTER, GROUP_DID].sort());
		expect(memberListCalls().filter((c) => c.did === GROUP_DID)).toEqual([]);
	});

	// Three membership records at two a page: a read that stopped at the first
	// page would see the third holder as an extra and take them off the list.
	it('repair reads every page of membership records before it takes anyone off the list', async () => {
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();

		await realRepair();

		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(memberListWrites().map((c) => c.did)).toEqual([STRANGER]);
		const membershipPages = pds.requests.filter(
			(r) =>
				r.nsid === 'com.atproto.space.listRecords' &&
				r.params.collection === GROUP_MEMBERSHIP_COLLECTION
		);
		expect(membershipPages.length).toBeGreaterThan(1);
	});

	it('repair takes nobody off the list when a page of membership records cannot be read', async () => {
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();
		failHost = (nsid, _init, query) =>
			nsid === 'com.atproto.space.listRecords' &&
			query?.get('collection') === GROUP_MEMBERSHIP_COLLECTION &&
			query.has('cursor')
				? Response.json({ error: 'UpstreamFailure' }, { status: 502 })
				: undefined;

		await expect(realRepair()).rejects.toThrow(/listRecords failed: 502/);

		expect(memberListWrites()).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([...ROSTER, STRANGER].sort());
	});
});

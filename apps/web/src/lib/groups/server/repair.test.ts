// The settings-page repair. The important cases are what it refuses to write:
// it copies the row into the records only where the row is certain. So these
// tests focus on where writing would be wrong: a non-owner row with no record
// (a failed grant looks the same as a failed removal), a record that disagrees
// with its row, and an authz config that is half there.
//
// It also brings the host in line with the records, never the other way round.
// Each space's `access` record is its policy (Spec: FR-214): the space's member
// list holds exactly the members whose roles that record grants `read`, and its
// read policy is public exactly when the record says public. The declaration
// follows the about space's record. Every case runs the repair as the settings
// page does, with nothing injected, against the fake host
// (./__fixtures__/stub-pds.ts) with the group's credential stored, and reads
// what the host received and holds. The host pages its listings small enough
// that a second page is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

/** Every URI our index was told about, in order. `down` makes it throw instead. */
const index = vi.hoisted(() => ({ told: [] as string[], down: null as Error | null }));

// The index runs in process over D1, and a real one would need its own database
// and an appview. So its client is replaced, and only that: the notifier that
// calls it is the app's own (./browse-index.test.ts runs the real one).
vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			if (index.down) throw index.down;
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		}
	})
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { stubPds, type StubPdsOptions } from './__fixtures__/stub-pds';

import {
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from './members-writer';
import { writeAboutAccess } from './about-writer';

import { readGroupMembers, hasAuthzRecords, rolePermissionsFromRecords } from './members-read';
import { describeRepair, repairGroup } from './repair';
import { ejectMember } from './roster';
import { pdsSpaceReader } from './about-read';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import { pdsProvisioner, pdsSpaceUpdater, provisionGroupSpaces } from './spaces';
import { tooOpen } from './__fixtures__/provisioned-spaces';
import {
	ABOUT_SPACE_TYPE,
	CALENDAR_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type GroupRow,
	type GroupVisibility
} from '../types';
import { GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY } from '../declaration-record';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION,
	groupAccessRecord
} from '../members-record';

import { POLICY_MEMBER_LIST, POLICY_PUBLIC, spaceUri } from '../ids';
import type { GroupRoleName } from '../permissions';
import { GroupPermissionError, pdsWriter } from './group-write';
import { createGroup, getGroupByDid, recordGroupSpaces } from './db/groups';
import { addMember, getMemberRow, listJoinRequests, requestJoin } from './db/roster';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const CALENDAR = spaceUri(GROUP_DID, CALENDAR_SPACE_TYPE, 'self');

const HANDLE = 'kona.group.stub.test';
const CRED = linkedCredential(GROUP_DID);

const MEMBER_LIST_METHODS = new Set([
	'com.atproto.simplespace.putMember',
	'com.atproto.simplespace.removeMember',
	'com.atproto.simplespace.listMembers'
]);

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let pds: ReturnType<typeof stubPds>;
/** Set by a case to answer one host call its own way. */
let failHost: StubPdsOptions['fail'] | null;
/** Set by a case to hear each write the host took, as it lands. */
let afterWrite: ((nsid: string) => void) | null;
let env: ReturnType<typeof linkGroups>;

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

/** The record writes the host received, in order, in a space or the public
 *  repo, and those into one collection. */
const recordWrites = () => pds.writes().filter((w) => typeof w.body?.collection === 'string');
const wroteTo = (collection: string) =>
	recordWrites().filter((w) => w.body?.collection === collection);

/** The group's reader, as a request builds it. */
const hostReader = () => pdsSpaceReader(CRED, GROUP_DID);

/** Calls the host directly, the way the group's owner could from any client,
 *  so a case can set up a host that drifted from this site. */
async function hostCall(nsid: string, body: Record<string, unknown>) {
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/${nsid}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	expect(res.ok).toBe(true);
}

/** Changes a space's member list at the host directly, the way the group's
 *  owner could from any client, so a case can set up a list that drifted. A
 *  put gets the access this app gives every entry, read and write, unless the
 *  case names another. */
async function hostList(
	method: 'putMember' | 'removeMember',
	space: string,
	did: string,
	access = { read: true, write: true }
) {
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.simplespace.${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(method === 'putMember' ? { space, did, ...access } : { space, did })
	});
	expect(res.ok).toBe(true);
}

/** A space's read policy, as the host reports it. */
const policy = (name: string) => ({ $type: name });

/** Moves a space's read policy at the host, through the group's own session,
 *  so a case can set up a host that drifted from the records. */
const setReadPolicy = (space: string, readPolicy: string) =>
	pdsSpaceUpdater(CRED, GROUP_DID)({ space, readPolicy: readPolicy as typeof POLICY_PUBLIC });

/** Writes a space's `access` record through the group's own session, past no
 *  gate: the roles that may read it, and whether it is public. */
const setAccess = (space: string, spaceType: string, roles: GroupRoleName[], isPublic: boolean) =>
	pdsWriter(
		CRED,
		GROUP_DID
	)({
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record: {
			...groupAccessRecord({
				spaceType,
				roles,
				public: isPublic
			}),
			$type: GROUP_ACCESS_COLLECTION
		},
		intent: 'update',
		space
	});

/**
 * A complete group as a create leaves it for `visibility`, but undeclared: the
 * three access records, the space index, the owner's membership record and the
 * authz config, the owner on all three member lists, and a public group's about
 * space opened after its access record says public. So the only thing a repair
 * can find to change is what the case sets up.
 */
async function seedComplete(visibility: GroupVisibility) {
	const seed = { db, env, group, callerDid: GROUP_DID };
	await writeGroupAccess(seed);
	await writeGroupAccess({ ...seed, space: CALENDAR });
	await writeGroupSpaceIndex({ ...seed, existing: [], calendarSpace: CALENDAR });
	await writeAboutAccess({ ...seed, visibility });
	if (visibility === 'public') await setReadPolicy(ABOUT, POLICY_PUBLIC);
	await putGroupMembership({ ...seed, subject: OWNER, roles: ['owner'], intent: 'admit' });
	await writeGroupAuthz(seed);
	for (const space of [MEMBERS, ABOUT, CALENDAR]) await hostList('putMember', space, OWNER);
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	env = linkGroups([GROUP_DID]);
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });

	// The host pages two at a time, so any listing of three or more has a second
	// page that a one-call read would miss.
	failHost = null;
	afterWrite = null;
	pds = stubPds({
		did: GROUP_DID,
		handle: HANDLE,
		recordPageSize: 2,
		memberPageSize: 2,
		fail: (nsid, init, query) => failHost?.(nsid, init, query),
		afterWrite: (nsid) => afterWrite?.(nsid)
	});
	// A create interrupted after its spaces: all three provisioned member-list,
	// and nothing written into any of them yet.
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID));
	expect(uris).toEqual({
		aboutSpaceUri: ABOUT,
		membersSpaceUri: MEMBERS,
		calendarSpaceUri: CALENDAR
	});
	await recordGroupSpaces(db, group.id, uris);
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };
	pds.clearLog();
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

/** Repair as the settings page runs it, on the group's current row. By default as
 *  the group's own account: a group missing its authz config grants its owner
 *  nothing, so that is who repairs one (Spec: FR-213). */
const repair = async (callerDid: string | null = GROUP_DID) =>
	repairGroup({ db, env, group: (await getGroupByDid(db, GROUP_DID))!, callerDid });

describe('repairGroup', () => {
	// The rows grant nothing, so a group missing its authz config has no member who
	// may repair it. Its own account may, and that is the recovery. (Spec: FR-213.)
	it('refuses the owner of a group with no authz config, and writes nothing', async () => {
		await expect(repair(OWNER)).rejects.toBeInstanceOf(GroupPermissionError);
		expect(pds.writes()).toEqual([]);
	});

	// A create interrupted after the INSERT: a row and three empty spaces.
	it("completes an interrupted create: access, the space index, the owner's membership, then the authz config", async () => {
		const result = await repair();

		expect(result.wrote).toEqual({
			access: true,
			calendarAccess: true,
			aboutAccess: true,
			spaceIndex: true,
			ownerMembership: true,
			authz: true
		});
		expect(result.unrecordedMembers).toEqual([]);
		expect(result.authzHeldBack).toBeNull();
		// The config goes last: once it exists the gate reads records, so the
		// owner's record must already be there.
		const order = recordWrites().map((w) => w.body?.collection);
		expect(order.indexOf(GROUP_ACCESS_COLLECTION)).toBeLessThan(
			order.indexOf(GROUP_SPACE_COLLECTION)
		);
		expect(order.indexOf(GROUP_SPACE_COLLECTION)).toBeLessThan(
			order.indexOf(GROUP_MEMBERSHIP_COLLECTION)
		);
		expect(order.indexOf(GROUP_MEMBERSHIP_COLLECTION)).toBeLessThan(
			order.indexOf(GROUP_ROLE_COLLECTION)
		);
		const members = await readGroupMembers(hostReader(), group);
		expect(hasAuthzRecords(members)).toBe(true);
		expect(members.memberships.map((m) => [m.subject, m.roles])).toEqual([[OWNER, ['owner']]]);
		// The about space had no access record, which already meant private, so
		// the one written says private and the space stays closed. Every record
		// grants the owner's role read, so the owner is on all three lists.
		expect(pds.record(ABOUT, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY)?.public).toBe(false);
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy(POLICY_MEMBER_LIST));
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.members(space)).toEqual([{ did: OWNER, read: true, write: true }]);
		}
		expect(result.policy).toEqual({ visibility: 'private', readPolicies: {}, declaration: null });
	});

	it('writes nothing the second time', async () => {
		await repair();
		pds.clearLog();
		const again = await repair();
		expect(pds.writes()).toEqual([]);
		expect(again.wrote).toEqual({
			access: false,
			calendarAccess: false,
			aboutAccess: false,
			spaceIndex: false,
			ownerMembership: false,
			authz: false
		});
	});

	// A later member's record exists, the owner's does not, and there is no
	// authz config.
	it("writes the owner's missing record when another member's exists", async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: GROUP_DID,
			subject: MEMBER,
			roles: ['member'],
			intent: 'admit'
		});
		pds.clearLog();

		const result = await repair();

		expect(result.wrote).toEqual({
			access: true,
			calendarAccess: true,
			aboutAccess: true,
			spaceIndex: true,
			ownerMembership: true,
			authz: true
		});
		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION).map((w) => w.body?.rkey)).toEqual([OWNER]);
	});

	// A failed admission and a failed removal leave the same row, so the row
	// cannot say which one happened, and the config would strip the member.
	it('never writes a non-owner row that has no record, and holds the config back', async () => {
		await addMember(db, group.id, MEMBER, 'member');

		const result = await repair();

		expect(result.unrecordedMembers).toEqual([MEMBER]);
		expect(result.wrote).toEqual({
			access: true,
			calendarAccess: true,
			aboutAccess: true,
			spaceIndex: true,
			ownerMembership: true,
			authz: false
		});
		expect(result.authzHeldBack).toBe('unrecorded-members');
		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION).map((w) => w.body?.rkey)).toEqual([OWNER]);
		expect(wroteTo(GROUP_PERMISSIONS_COLLECTION)).toEqual([]);
		// And the rebuild leaves the row alone rather than deleting it.
		expect(await getMemberRow(db, group.id, MEMBER)).not.toBeNull();
	});

	it('leaves a record that disagrees with its row as it is, and the rebuild follows the record', async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: GROUP_DID,
			subject: MEMBER,
			roles: ['admin'],
			intent: 'admit'
		});
		pds.clearLog();

		await repair();

		expect(wroteTo(GROUP_MEMBERSHIP_COLLECTION).filter((w) => w.body?.rkey === MEMBER)).toEqual([]);
		const members = await readGroupMembers(hostReader(), group);
		expect(members.memberships.find((m) => m.subject === MEMBER)?.roles).toEqual(['admin']);
		expect((await getMemberRow(db, group.id, MEMBER))?.role).toBe('admin');
	});

	// A create that failed partway through the config: the owner's record went,
	// then the roles and community bindings, and the event bindings did not.
	it('does not complete a half-present authz config', async () => {
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: GROUP_DID,
			subject: OWNER,
			roles: ['owner'],
			intent: 'admit'
		});
		await writeGroupAuthz({ db, env, group, callerDid: GROUP_DID });
		await hostCall('com.atproto.space.deleteRecord', {
			space: MEMBERS,
			repo: GROUP_DID,
			collection: GROUP_EVENT_PERMISSIONS_COLLECTION,
			rkey: GROUP_PERMISSIONS_RKEY
		});
		pds.clearLog();

		const result = await repair();

		expect(result.authzHeldBack).toBe('partial');
		expect(result.wrote.authz).toBe(false);
		expect(wroteTo(GROUP_PERMISSIONS_COLLECTION)).toEqual([]);
		expect(wroteTo(GROUP_EVENT_PERMISSIONS_COLLECTION)).toEqual([]);
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

		const members = await readGroupMembers(hostReader(), group);
		const admin = rolePermissionsFromRecords(members, GROUP_DID).admin;
		expect(admin).not.toContain('ASSIGN_ROLES');
		expect(admin).toContain('ADMIT_MEMBERS');
	});

	// The standard wants exactly one index entry per space. A second entry for a
	// space, such as two repairs racing would leave, loses to the oldest, and an
	// entry for a space that is not one of the group's three is not this repair's.
	it('keeps one index entry per space: adds what is missing, deletes the younger of two, and leaves other spaces alone', async () => {
		const index = (rkey: string, space: string) =>
			hostCall('com.atproto.space.createRecord', {
				space: MEMBERS,
				repo: GROUP_DID,
				collection: GROUP_SPACE_COLLECTION,
				rkey,
				record: { $type: GROUP_SPACE_COLLECTION, space, createdAt: '2026-09-30T12:00:00.000Z' }
			});
		const EVENTS = spaceUri(GROUP_DID, 'group.lexicon.calendar.events', 'self');
		await index('3m2aaaaaaaaa2', ABOUT);
		await index('3m2aaaaaaaaa3', ABOUT);
		await index('3m2aaaaaaaaa4', EVENTS);
		pds.clearLog();

		const result = await repair();

		expect(
			wroteTo(GROUP_SPACE_COLLECTION).map((w) => [
				w.nsid,
				w.nsid === 'com.atproto.space.deleteRecord'
					? w.body?.rkey
					: (w.body?.record as { space?: string }).space
			])
		).toEqual([
			['com.atproto.space.deleteRecord', '3m2aaaaaaaaa3'],
			['com.atproto.space.createRecord', MEMBERS],
			['com.atproto.space.createRecord', CALENDAR]
		]);
		expect(result.wrote.spaceIndex).toBe(true);
		const live = (
			await hostReader().list({
				space: MEMBERS,
				repo: GROUP_DID,
				collection: GROUP_SPACE_COLLECTION
			})
		).map((r) => [r.rkey, r.value.space]);
		expect(live).toEqual(
			expect.arrayContaining([
				['3m2aaaaaaaaa2', ABOUT],
				['3m2aaaaaaaaa4', EVENTS]
			])
		);
		expect(live).toHaveLength(4);

		const again = await repair();
		expect(again.wrote.spaceIndex).toBe(false);
	});

	it('refuses a caller without MANAGE_GROUP and writes nothing', async () => {
		await addMember(db, group.id, MEMBER, 'member');
		await expect(repair(MEMBER)).rejects.toBeInstanceOf(GroupPermissionError);
		await expect(repair(null)).rejects.toBeInstanceOf(GroupPermissionError);
		expect(pds.writes()).toEqual([]);
	});
});

// Each member list is read access at the host, so Repair makes each one equal
// the DIDs whose membership record names a role that space's `access` record
// grants `read`: never the rows, which cannot tell a failed admission from a
// failed removal. Every entry is read and write. (Spec: FR-206, FR-214, SC-205.)
// These cases run the real transports end to end: the records, the reader and
// the lists all go through the group's stored credential to the fake host.
describe('each member list follows the membership records and its space’s access record', () => {
	const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
	// Sorted by DID, the host's order: the stranger lands on the first page of
	// the list and the extra on the second.
	const STRANGER = 'did:plc:aaaastrangeraaaaaaaaaaaa';
	const PAGE_TWO_EXTRA = 'did:plc:zzzzpagetwoextrazzzzzzzz';
	const ROSTER = [OWNER, ADMIN, MEMBER].sort();
	const SPACES = [MEMBERS, ABOUT, CALENDAR];

	// A complete public group: owner, admin and member rows with a membership
	// record each, the three access records granting every role read, the authz
	// config, and all three lists already holding all three.
	beforeEach(async () => {
		await seedComplete('public');
		await addMember(db, group.id, ADMIN, 'admin');
		await addMember(db, group.id, MEMBER, 'member');
		const seed = { db, env, group, callerDid: GROUP_DID };
		for (const [subject, role] of [
			[ADMIN, 'admin'],
			[MEMBER, 'member']
		] as const) {
			await putGroupMembership({ ...seed, subject, roles: [role], intent: 'admit' });
		}
		for (const did of [ADMIN, MEMBER]) {
			for (const space of SPACES) await hostList('putMember', space, did);
		}
		pds.clearLog();
	});

	// An entry with other access, such as a read-only one from before members
	// could write in the about space, is rewritten.
	it('repair makes the about space list equal the membership records, read and write', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, STRANGER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		await hostList('putMember', ABOUT, ADMIN, { read: true, write: false });
		pds.clearLog();

		const result = await repair();

		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(pds.members(ABOUT).every((m) => m.read && m.write)).toBe(true);
		expect(result.lists.about).toEqual({
			added: [ADMIN, MEMBER].sort(),
			removed: [STRANGER, PAGE_TWO_EXTRA]
		});
		expect(memberListCalls().filter((c) => c.did === GROUP_DID)).toEqual([]);
		// The other two lists already held the roster, so neither is written.
		expect(memberListWrites().filter((c) => c.space !== ABOUT)).toEqual([]);
	});

	// An entry with other access, such as a write-only one from before members
	// could read the space, is rewritten.
	it('repair makes the members space list equal the membership records, read and write', async () => {
		await hostList('removeMember', MEMBERS, MEMBER);
		await hostList('putMember', MEMBERS, STRANGER);
		await hostList('putMember', MEMBERS, ADMIN, { read: false, write: true });
		pds.clearLog();

		const result = await repair();

		expect(pds.listed(MEMBERS)).toEqual(ROSTER);
		expect(pds.members(MEMBERS).every((m) => m.read && m.write)).toBe(true);
		expect(result.lists.members).toEqual({ added: [ADMIN, MEMBER].sort(), removed: [STRANGER] });
	});

	// A group from before members were listed on the calendar space: its
	// access grants every role read, so every member gets an entry, and can read
	// members-only events with their own credential.
	it('repair lists every member on the calendar space, read and write', async () => {
		for (const did of ROSTER) await hostList('removeMember', CALENDAR, did);
		pds.clearLog();

		const result = await repair();

		expect(pds.members(CALENDAR)).toEqual(ROSTER.map((did) => ({ did, read: true, write: true })));
		expect(result.lists.calendar).toEqual({ added: ROSTER, removed: [] });
		expect(memberListWrites().filter((c) => c.space !== CALENDAR)).toEqual([]);
	});

	// The lists follow each space's own record. A calendar space whose access
	// no longer grants `member` read takes the member off that list only: the
	// other two spaces still grant it.
	it('repair takes a member off only the list of a space whose access does not grant their role read', async () => {
		await setAccess(CALENDAR, CALENDAR_SPACE_TYPE, ['owner', 'admin'], false);
		expect(tooOpen(pds, GROUP_DID)).toEqual([
			`${MEMBER} is on the calendar space's list, which its roles do not read`
		]);
		pds.clearLog();

		const result = await repair();

		expect(pds.listed(CALENDAR)).toEqual([OWNER, ADMIN].sort());
		expect(pds.listed(MEMBERS)).toEqual(ROSTER);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(result.lists).toEqual({
			members: { added: [], removed: [] },
			about: { added: [], removed: [] },
			calendar: { added: [], removed: [MEMBER] }
		});
		expect(tooOpen(pds, GROUP_DID)).toEqual([]);
		// The record is the policy: the repair never rewrites it.
		expect(wroteTo(GROUP_ACCESS_COLLECTION)).toEqual([]);
	});

	// A requester is not a member, so a pending request holds no entry on any
	// list, and the repair takes one off, such as an entry from before requests
	// stopped getting one. The request itself, in D1 only, stands. (Spec: FR-206,
	// SC-205.)
	it('repair takes a pending requester off every list, and the request stands', async () => {
		const REQUESTER = 'did:plc:requesteraaaaaaaaaaaaaaaa';
		await requestJoin(db, group, REQUESTER, null, 'public');
		await hostList('putMember', MEMBERS, REQUESTER, { read: false, write: true });
		await hostList('putMember', ABOUT, REQUESTER, { read: true, write: false });
		await hostList('putMember', CALENDAR, REQUESTER);
		pds.clearLog();

		const result = await repair();

		for (const space of SPACES) expect(pds.listed(space)).toEqual(ROSTER);
		expect(result.lists).toEqual({
			members: { added: [], removed: [REQUESTER] },
			about: { added: [], removed: [REQUESTER] },
			calendar: { added: [], removed: [REQUESTER] }
		});
		expect(await listJoinRequests(db, group.id)).toMatchObject([{ did: REQUESTER }]);
	});

	// A list emptied at the host comes back from the records. (Spec: SC-205.)
	it('repair rebuilds emptied lists from the membership records', async () => {
		for (const space of SPACES) {
			for (const did of ROSTER) await hostList('removeMember', space, did);
		}
		pds.clearLog();

		await repair();

		for (const space of SPACES) expect(pds.listed(space)).toEqual(ROSTER);
	});

	it('a second repair makes no member-list write', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		await hostList('removeMember', CALENDAR, ADMIN);
		await repair();
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		pds.clearLog();

		await repair();

		expect(memberListWrites()).toEqual([]);
		for (const space of SPACES) expect(pds.listed(space)).toEqual(ROSTER);
	});

	// An eject deletes the record first, and the lists follow the records, so
	// the repair finishes the host's half of one that stopped partway and never
	// lists the DID again.
	it.each([['the list entries', 'com.atproto.simplespace.removeMember']])(
		'repair takes off, and never re-lists, a member whose eject stopped at %s',
		async (_half, method) => {
			failHost = (nsid) =>
				nsid === method ? Response.json({ error: 'UpstreamFailure' }, { status: 502 }) : undefined;
			await ejectMember({ db, env, group, callerDid: OWNER }, MEMBER).catch(() => {});
			failHost = null;
			expect(await getMemberRow(db, group.id, MEMBER)).not.toBeNull();

			await repair();

			for (const space of SPACES) expect(pds.listed(space)).toEqual([OWNER, ADMIN].sort());
		}
	);

	// A failed admission and a failed removal leave the same row, so a row with
	// no record is never put on a list, just as it is never written a record.
	it('repair never lists a member whose row has no membership record', async () => {
		const UNRECORDED = 'did:plc:unrecordedaaaaaaaaaaaaaa';
		await addMember(db, group.id, UNRECORDED, 'member');
		await hostList('removeMember', ABOUT, MEMBER);
		pds.clearLog();

		const result = await repair();

		expect(result.unrecordedMembers).toEqual([UNRECORDED]);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(memberListWrites().map((c) => c.did)).toEqual([MEMBER]);
		// The authz config exists, so the row grants nothing and only Remove
		// finishes it; a role change would re-admit them.
		const summary = describeRepair(result);
		expect(summary).toContain('"Not finished" on the members page, where Remove finishes it');
		expect(summary).not.toContain('role');
	});

	it('repair never puts or removes the group’s own DID', async () => {
		await hostList('putMember', ABOUT, GROUP_DID);
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();

		await repair();

		expect(pds.listed(ABOUT)).toEqual([...ROSTER, GROUP_DID].sort());
		expect(memberListCalls().filter((c) => c.did === GROUP_DID)).toEqual([]);
	});

	// Three membership records at two a page: a read that stopped at the first
	// page would see the third holder as an extra and take them off the list.
	it('repair reads every page of membership records before it takes anyone off a list', async () => {
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();

		await repair();

		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(memberListWrites().map((c) => c.did)).toEqual([STRANGER]);
		const membershipPages = pds.requests.filter(
			(r) =>
				r.nsid === 'com.atproto.space.listRecords' &&
				r.params.collection === GROUP_MEMBERSHIP_COLLECTION
		);
		expect(membershipPages.length).toBeGreaterThan(1);
	});

	it('repair takes nobody off a list when a page of membership records cannot be read', async () => {
		await hostList('putMember', ABOUT, STRANGER);
		pds.clearLog();
		failHost = (nsid, _init, query) =>
			nsid === 'com.atproto.space.listRecords' &&
			query?.get('collection') === GROUP_MEMBERSHIP_COLLECTION &&
			query.has('cursor')
				? Response.json({ error: 'UpstreamFailure' }, { status: 502 })
				: undefined;

		await expect(repair()).rejects.toThrow(/listRecords failed: 502/);

		expect(memberListWrites()).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([...ROSTER, STRANGER].sort());
	});
});

// The group's visibility is its about space's `access.public`, and each space's
// read policy follows that space's own record (Spec: FR-214). So Repair moves
// the host to the records, whichever way they disagree, and never writes a
// record to match the host: a read policy that drifted open is closed, and one
// a failed save left closed is opened. The declaration in the public repo
// follows the about space's record. The row has no visibility to align. These
// cases run every transport for real, the declaration probe included, so a
// second run sees what the first one wrote.
describe('Repair moves the host and the declaration to the access records', () => {
	async function declared(): Promise<boolean> {
		const query = new URLSearchParams({
			repo: GROUP_DID,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY
		});
		return (await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.repo.getRecord?${query}`)).ok;
	}

	async function declare() {
		await hostCall('com.atproto.repo.putRecord', {
			repo: GROUP_DID,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY,
			record: { meta: ABOUT, createdAt: new Date(group.created_at).toISOString() }
		});
	}

	/** Every host write in order, by method, and what `updateSpace` moved. */
	const traced = () =>
		pds.writes().map((w) => {
			const method = w.nsid.replace('com.atproto.', '');
			if (w.nsid !== 'com.atproto.simplespace.updateSpace') return method;
			const readPolicy = (w.body?.readPolicy as { $type?: string } | undefined)?.$type;
			return `${method} ${w.body?.space === ABOUT ? 'about' : w.body?.space} ${readPolicy?.split('#')[1]}`;
		});

	/** Runs the repair checking, after each write the host takes, that no space
	 *  is more open than its access record says. */
	async function repairNeverTooOpen() {
		const heard: string[] = [];
		const seen: string[] = [];
		afterWrite = (nsid) => {
			heard.push(nsid);
			seen.push(...tooOpen(pds, GROUP_DID).map((f) => `${nsid}: ${f}`));
		};
		const result = await repair();
		afterWrite = null;
		expect(heard).toEqual(pds.writes().map((w) => w.nsid));
		expect(seen).toEqual([]);
		return result;
	}

	beforeEach(async () => {
		await seedComplete('public');
		index.told = [];
		index.down = null;
		vi.spyOn(console, 'error').mockImplementation(() => {});
		pds.clearLog();
	});

	afterEach(() => vi.restoreAllMocks());

	// A save going private whose index notice was lost leaves browse listing the
	// group, and the repo no longer holds a declaration to withdraw. So every
	// repair of a private group tells the index again, which drops a stale entry.
	it('tells the index again about a private group whose repo holds no declaration', async () => {
		await setReadPolicy(ABOUT, POLICY_MEMBER_LIST);
		await writeAboutAccess({ db, env, group, callerDid: GROUP_DID, visibility: 'private' });
		expect(await declared()).toBe(false);

		await repair();

		expect(index.told).toEqual([`at://${GROUP_DID}/${GROUP_DECLARATION_COLLECTION}/self`]);
	});

	// The about space's read policy drifted open while its record says private,
	// and the group is still declared: the host closes first, then the
	// declaration goes. The record is the policy, so it is not rewritten.
	it('closes an about space its access record says is private, then withdraws the declaration, and writes no record', async () => {
		await writeAboutAccess({ db, env, group, callerDid: GROUP_DID, visibility: 'private' });
		await declare();
		pds.clearLog();

		const result = await repair();

		expect(traced()).toEqual([
			'simplespace.updateSpace about memberListPolicy',
			'repo.deleteRecord'
		]);
		expect(result.policy).toEqual({
			visibility: 'private',
			readPolicies: { about: POLICY_MEMBER_LIST },
			declaration: 'withdrawn'
		});
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy(POLICY_MEMBER_LIST));
		expect(await declared()).toBe(false);
		expect(wroteTo(GROUP_ACCESS_COLLECTION)).toEqual([]);
		expect(tooOpen(pds, GROUP_DID)).toEqual([]);

		pds.clearLog();
		await repair();
		expect(pds.writes()).toEqual([]);
	});

	// A save going public whose host step failed: the record says public and the
	// host is still closed. The repair finishes it, opening the space before it
	// declares, and the host is never more open than the record along the way.
	// A space more open than its record is the one drift that exposes something,
	// so it closes before the repair changes anything else at the host, the
	// member lists included.
	it('closes a space more open than its access record before it writes any member list', async () => {
		await writeAboutAccess({ db, env, group, callerDid: GROUP_DID, visibility: 'private' });
		await hostList('removeMember', ABOUT, OWNER);
		pds.clearLog();

		await repair();

		expect(traced()).toEqual([
			'simplespace.updateSpace about memberListPolicy',
			'simplespace.putMember'
		]);
		expect(pds.listed(ABOUT)).toEqual([OWNER]);
	});

	it('opens an about space its access record says is public, then declares, and writes no record', async () => {
		await setReadPolicy(ABOUT, POLICY_MEMBER_LIST);
		pds.clearLog();

		const result = await repairNeverTooOpen();

		expect(traced()).toEqual(['simplespace.updateSpace about publicPolicy', 'repo.putRecord']);
		expect(result.policy).toEqual({
			visibility: 'public',
			readPolicies: { about: POLICY_PUBLIC },
			declaration: 'declared'
		});
		expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy(POLICY_PUBLIC));
		expect(await declared()).toBe(true);
		expect(wroteTo(GROUP_ACCESS_COLLECTION)).toEqual([]);

		pds.clearLog();
		await repair();
		expect(pds.writes()).toEqual([]);
	});

	// The members and calendar spaces' records are never public, so a read
	// policy that drifted public is closed, whatever the group's visibility,
	// and the group stays public.
	it.each([
		['members', MEMBERS],
		['calendar', CALENDAR]
	] as const)(
		'closes the %s space when its host reads public and its access record does not say public',
		async (kind, space) => {
			await declare();
			await setReadPolicy(space, POLICY_PUBLIC);
			expect(tooOpen(pds, GROUP_DID)).toEqual([
				`the ${kind} space is public while its access record does not say public`
			]);
			pds.clearLog();

			const result = await repair();

			expect(result.policy).toEqual({
				visibility: 'public',
				readPolicies: { [kind]: POLICY_MEMBER_LIST },
				declaration: null
			});
			expect(pds.writes().map((w) => [w.nsid, w.body?.space])).toEqual([
				['com.atproto.simplespace.updateSpace', space]
			]);
			expect(pds.spaces.get(space)?.readPolicy).toEqual(policy(POLICY_MEMBER_LIST));
			expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual(policy(POLICY_PUBLIC));
			expect(await declared()).toBe(true);
			expect(tooOpen(pds, GROUP_DID)).toEqual([]);

			pds.clearLog();
			await repair();
			expect(pds.writes()).toEqual([]);
		}
	);

	// No access record means no one was granted a public about space. The
	// repair writes the record saying private, then closes the host and
	// withdraws the declaration to match it.
	it('writes a missing about space access record as private, closes the space and withdraws the declaration', async () => {
		await declare();
		await hostCall('com.atproto.space.deleteRecord', {
			space: ABOUT,
			repo: GROUP_DID,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY
		});
		pds.clearLog();

		const result = await repair();

		expect(result.wrote.aboutAccess).toBe(true);
		expect(traced()).toEqual([
			'space.putRecord',
			'simplespace.updateSpace about memberListPolicy',
			'repo.deleteRecord'
		]);
		expect(pds.record(ABOUT, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY)).toEqual({
			$type: GROUP_ACCESS_COLLECTION,
			public: false,
			grants: ['owner', 'admin', 'member'].map((role) => ({
				role,
				scopes: ['space:group.opensocial.meta?action=read']
			}))
		});
		expect(result.policy).toEqual({
			visibility: 'private',
			readPolicies: { about: POLICY_MEMBER_LIST },
			declaration: 'withdrawn'
		});
		expect(await declared()).toBe(false);
		// The new record grants every role read, so the owner stays listed.
		expect(pds.listed(ABOUT)).toEqual([OWNER]);
		expect(describeRepair(result)).toContain(
			'With no access record for its about space, the group was already private'
		);

		pds.clearLog();
		const again = await repair();
		expect(again.wrote.aboutAccess).toBe(false);
		expect(pds.writes()).toEqual([]);
	});

	// What the settings page shows: which space changed and how, in plain words.
	it('describes a closed space and a list change in words an owner can read', async () => {
		const STRANGER = 'did:plc:aaaastrangeraaaaaaaaaaaa';
		await declare();
		await setReadPolicy(CALENDAR, POLICY_PUBLIC);
		await hostList('putMember', CALENDAR, STRANGER);
		pds.clearLog();

		const summary = describeRepair(await repair());

		expect(summary).toContain(
			"Brought the calendar space's member list at the group's PDS in line with the membership records and the space's access record: removed 1 member."
		);
		expect(summary).toContain(
			"Brought the group's PDS in line with its access records, which make it public: closed the calendar space to all but its members."
		);
	});
});

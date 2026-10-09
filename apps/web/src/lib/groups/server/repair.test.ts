// The settings-page repair. The important cases are what it refuses to write:
// it copies the row into the records only where the row is certain. So these
// tests focus on where writing would be wrong: a non-owner row with no record
// (a failed grant looks the same as a failed removal), a record that disagrees
// with its row, and an authz config that is half there.
//
// It also brings the about space's member list in line with the membership
// records, and the declaration in line with the about space's read policy.
// Every case runs the repair as the settings page does, with nothing injected,
// against the fake host (./__fixtures__/stub-pds.ts) with the group's
// credential stored, and reads what the host received and holds. The host
// pages its listings small enough that a second page is real.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
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

import { readGroupMembers, hasAuthzRecords } from './members-read';
import { repairGroup } from './repair';
import { pdsSpaceReader } from './about-read';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import { pdsProvisioner, provisionGroupSpaces } from './spaces';
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
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION
} from '../members-record';

import { spaceUri } from '../ids';
import { GroupPermissionError } from './group-write';
import { createGroup, getGroupByDid, recordGroupSpaces } from './db/groups';
import { addMember, getMemberRow, requestJoin } from './db/roster';
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
 *  put gets the access this app gives that space's entries unless the case
 *  names another. */
async function hostList(
	method: 'putMember' | 'removeMember',
	space: string,
	did: string,
	access = space === MEMBERS ? { read: false, write: true } : { read: true, write: false }
) {
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.simplespace.${method}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(method === 'putMember' ? { space, did, ...access } : { space, did })
	});
	expect(res.ok).toBe(true);
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	env = linkGroups([GROUP_DID]);
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });

	// The host pages two at a time, so any listing of three or more has a second
	// page that a one-call read would miss.
	failHost = null;
	pds = stubPds({
		did: GROUP_DID,
		handle: HANDLE,
		recordPageSize: 2,
		memberPageSize: 2,
		fail: (nsid, init, query) => failHost?.(nsid, init, query)
	});
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public');
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

/** Repair as the settings page runs it, on the group's current row. */
const repair = async (callerDid: string | null = OWNER) =>
	repairGroup({ db, env, group: (await getGroupByDid(db, GROUP_DID))!, callerDid });

describe('repairGroup', () => {
	// A create interrupted after the INSERT: a row and an empty members space.
	it("completes an interrupted create: access, the space index, the owner's membership, then the authz config", async () => {
		const result = await repair();

		expect(result.wrote).toEqual({
			access: true,
			calendarAccess: true,
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
	});

	it('writes nothing the second time', async () => {
		await repair();
		pds.clearLog();
		const again = await repair();
		expect(pds.writes()).toEqual([]);
		expect(again.wrote).toEqual({
			access: false,
			calendarAccess: false,
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
			callerDid: OWNER,
			subject: MEMBER,
			roles: ['member'],
			intent: 'admit'
		});
		pds.clearLog();

		const result = await repair();

		expect(result.wrote).toEqual({
			access: true,
			calendarAccess: true,
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
			callerDid: OWNER,
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
			callerDid: OWNER,
			subject: OWNER,
			roles: ['owner'],
			intent: 'admit'
		});
		await writeGroupAuthz({ db, env, group, callerDid: OWNER });
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
		const admin = members.permissions?.bindings.find((b) => b.role === 'admin');
		expect(admin?.permissions).not.toContain('ASSIGN_ROLES');
		expect(admin?.permissions).toContain('ADMIT_MEMBERS');
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
		for (const did of ROSTER) {
			await hostList('putMember', ABOUT, did);
			await hostList('putMember', MEMBERS, did);
		}
		pds.clearLog();
	});

	it('repair makes the about space list equal the membership records', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, STRANGER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		pds.clearLog();

		await repair();

		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(pds.members(ABOUT).every((m) => m.read && !m.write)).toBe(true);
		expect(memberListCalls().filter((c) => c.did === GROUP_DID)).toEqual([]);
		// The members space's list already held the roster, so it is not written.
		expect(memberListWrites().filter((c) => c.space === MEMBERS)).toEqual([]);
	});

	// The write-only entries are host state, so the repair re-derives them from
	// the membership records, plus the pending requests that only D1 holds.
	// (Spec: FR-206, SC-205.)
	it('repair makes the members space list equal the membership records plus pending requests, write-only', async () => {
		const REQUESTER = 'did:plc:requesteraaaaaaaaaaaaaaaa';
		await requestJoin(db, group, REQUESTER, null, 'public');
		await hostList('removeMember', MEMBERS, MEMBER);
		await hostList('putMember', MEMBERS, STRANGER);
		// A stray read grant on the roster's own space, set by hand at the host.
		await hostList('putMember', MEMBERS, ADMIN, { read: true, write: true });
		pds.clearLog();

		const result = await repair();

		expect(pds.listed(MEMBERS)).toEqual([...ROSTER, REQUESTER].sort());
		expect(pds.members(MEMBERS).every((m) => !m.read && m.write)).toBe(true);
		expect(result.writers).toEqual({
			added: [ADMIN, MEMBER, REQUESTER].sort(),
			removed: [STRANGER]
		});
	});

	// A requester is in D1 only, so the repair must read join_requests or it
	// would take their entry off while the request stands. (Spec: SC-205.)
	it('repair keeps a pending requester on the members space list', async () => {
		const REQUESTER = 'did:plc:requesteraaaaaaaaaaaaaaaa';
		await requestJoin(db, group, REQUESTER, null, 'public');
		await hostList('putMember', MEMBERS, REQUESTER);
		pds.clearLog();

		const result = await repair();

		expect(pds.listed(MEMBERS)).toContain(REQUESTER);
		expect(result.writers).toEqual({ added: [], removed: [] });
		expect(memberListWrites()).toEqual([]);
	});

	// A list emptied at the host comes back from the records. (Spec: SC-205.)
	it('repair rebuilds an emptied members space list from the membership records', async () => {
		for (const did of ROSTER) await hostList('removeMember', MEMBERS, did);
		pds.clearLog();

		await repair();

		expect(pds.listed(MEMBERS)).toEqual(ROSTER);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
	});

	it('a second repair makes no member-list write', async () => {
		await hostList('removeMember', ABOUT, MEMBER);
		await hostList('putMember', ABOUT, PAGE_TWO_EXTRA);
		await repair();
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		pds.clearLog();

		await repair();

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

		const result = await repair();

		expect(result.unrecordedMembers).toEqual([UNRECORDED]);
		expect(pds.listed(ABOUT)).toEqual(ROSTER);
		expect(memberListWrites().map((c) => c.did)).toEqual([MEMBER]);
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
	it('repair reads every page of membership records before it takes anyone off the list', async () => {
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

	it('repair takes nobody off the list when a page of membership records cannot be read', async () => {
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

// Visibility lives at the host: the about space's read policy is what the page
// gate reads. Repair brings the one other place that says it, the declaration
// in the public repo, in line with that policy. Never the other way round: it
// does not call updateSpace, so a change of visibility that reached the host is
// never undone by a declaration that missed it. The row has no visibility to
// align. These cases run every transport for real, the declaration probe
// included, so a second run sees what the first one wrote.
describe('Repair aligns the declaration to the host', () => {
	const policyName = (visibility: GroupVisibility) =>
		visibility === 'public' ? 'publicPolicy' : 'memberListPolicy';

	async function declared(): Promise<boolean> {
		const query = new URLSearchParams({
			repo: GROUP_DID,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: GROUP_DECLARATION_RKEY
		});
		return (await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.repo.getRecord?${query}`)).ok;
	}

	const updateSpaceCalls = () =>
		pds.requests.filter((r) => r.nsid === 'com.atproto.simplespace.updateSpace');

	// A complete group, as a public create leaves it: the owner's membership
	// record, the three access records, the space index, the authz config and
	// the owner on the about space's list. So the only thing a repair can find
	// to change is what the case sets up.
	beforeEach(async () => {
		const seed = { db, env, group, callerDid: OWNER };
		await writeGroupAccess(seed);
		await writeGroupAccess({ ...seed, space: CALENDAR });
		await writeGroupSpaceIndex({ ...seed, existing: [], calendarSpace: CALENDAR });
		await writeAboutAccess({ ...seed, visibility: 'public' });
		await putGroupMembership({ ...seed, subject: OWNER, roles: ['owner'], intent: 'admit' });
		await writeGroupAuthz(seed);
		await hostList('putMember', ABOUT, OWNER);
		await hostList('putMember', MEMBERS, OWNER);
		// The withdrawal tells our own index, which has nothing to tell here.
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	// The access record was seeded saying public, so a host that reads the group
	// as private also has it rewritten, after the withdrawal.
	it.each([
		['private', true, false, ['repo.deleteRecord', 'space.putRecord']],
		['public', false, true, ['repo.putRecord']]
	] as const)(
		'a host reading the group as %s, with the declaration present: %s, ends with the declaration present: %s, and never calls updateSpace',
		async (host, declaredBefore, declaredAfter, hostWrites) => {
			await hostCall('com.atproto.simplespace.updateSpace', {
				space: ABOUT,
				readPolicy: { $type: `com.atproto.simplespace.defs#${policyName(host)}` }
			});
			if (declaredBefore) {
				await hostCall('com.atproto.repo.putRecord', {
					repo: GROUP_DID,
					collection: GROUP_DECLARATION_COLLECTION,
					rkey: GROUP_DECLARATION_RKEY,
					record: { meta: ABOUT, createdAt: new Date(group.created_at).toISOString() }
				});
			}
			pds.clearLog();

			await repair();

			// It asked the host, and the only host writes are the declaration's
			// and the access record's: no updateSpace.
			expect(
				pds.requests.some(
					(r) => r.nsid === 'com.atproto.simplespace.getSpace' && r.params.space === ABOUT
				)
			).toBe(true);
			expect(pds.writes().map((w) => w.nsid.replace('com.atproto.', ''))).toEqual(hostWrites);
			expect(await declared()).toBe(declaredAfter);
			expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual({
				$type: `com.atproto.simplespace.defs#${policyName(host)}`
			});

			// Idempotent: a second run finds nothing to change.
			pds.clearLog();
			await repair();
			expect(pds.writes()).toEqual([]);
			expect(await declared()).toBe(declaredAfter);
		}
	);

	/** The about space's access record as the host holds it, or null. */
	async function aboutAccess(): Promise<Record<string, unknown> | null> {
		const found = await hostReader().get({
			space: ABOUT,
			repo: GROUP_DID,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: 'self'
		});
		return found?.value ?? null;
	}

	// The read policy is the visibility the host enforces, and the access record
	// only says it. So a disagreement is settled for the policy, whichever way
	// it runs, and a missing record is written from the policy too.
	it.each([
		['private', true],
		['public', null]
	] as const)(
		'a host reading the group as %s, with an access record that says public: %s, ends with the record saying what the host reads, and never calls updateSpace',
		async (host, recordSays) => {
			await hostCall('com.atproto.simplespace.updateSpace', {
				space: ABOUT,
				readPolicy: { $type: `com.atproto.simplespace.defs#${policyName(host)}` }
			});
			// The declaration agrees with the host, so only the access record is off.
			if (host === 'private') {
				await hostCall('com.atproto.repo.deleteRecord', {
					repo: GROUP_DID,
					collection: GROUP_DECLARATION_COLLECTION,
					rkey: GROUP_DECLARATION_RKEY
				});
			} else {
				await hostCall('com.atproto.repo.putRecord', {
					repo: GROUP_DID,
					collection: GROUP_DECLARATION_COLLECTION,
					rkey: GROUP_DECLARATION_RKEY,
					record: { meta: ABOUT, createdAt: new Date(group.created_at).toISOString() }
				});
			}
			if (recordSays === null) {
				await hostCall('com.atproto.space.deleteRecord', {
					space: ABOUT,
					repo: GROUP_DID,
					collection: GROUP_ACCESS_COLLECTION,
					rkey: 'self'
				});
			} else {
				await hostCall('com.atproto.space.putRecord', {
					space: ABOUT,
					repo: GROUP_DID,
					collection: GROUP_ACCESS_COLLECTION,
					rkey: 'self',
					record: {
						$type: GROUP_ACCESS_COLLECTION,
						public: recordSays,
						readRoles: ['owner', 'admin', 'member'],
						grants: []
					}
				});
			}
			pds.clearLog();

			const result = await repair();

			expect(result.host).toEqual({ visibility: host, declaration: null, access: true });
			expect(await aboutAccess()).toEqual({
				$type: GROUP_ACCESS_COLLECTION,
				public: host === 'public',
				readRoles: ['owner', 'admin', 'member'],
				grants: []
			});
			expect(
				pds.writes().map((w) => `${w.nsid.replace('com.atproto.', '')} ${w.body?.collection}`)
			).toEqual([`space.putRecord ${GROUP_ACCESS_COLLECTION}`]);
			// The policy is where it was: the record followed it, not the reverse.
			expect(updateSpaceCalls()).toEqual([]);
			expect(pds.spaces.get(ABOUT)?.readPolicy).toEqual({
				$type: `com.atproto.simplespace.defs#${policyName(host)}`
			});

			pds.clearLog();
			const again = await repair();
			expect(again.host.access).toBe(false);
			expect(pds.writes()).toEqual([]);
		}
	);
});

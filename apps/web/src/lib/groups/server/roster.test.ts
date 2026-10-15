// The roster acts, and the order their halves run in.
//
// Every roster act is a D1 row move plus a `membership` record write, and it
// also changes the group's three member lists at the host, which follow each
// space's `access` record (Spec: FR-214). The gate resolves from records, so the
// order decides which way a partial failure errs. The rule, by direction of the
// change:
//
//   * a grant (join, admit, promotion) moves the row first, so the schema
//     decides before anything is published, and a failed record write leaves
//     the old, smaller grant in the record. It then lists the DID on each space
//     its role reads, last;
//   * a revocation (leave, eject, demotion) runs a read-only pre-check, then
//     changes the record, which closes atmo's gate, then takes the DID off the
//     lists (an exit: all three; a demotion: where the new role reads nothing),
//     then the row, so a failed later write leaves a record that already grants
//     less.
//
// Each case makes exactly one half fail and checks what the gate says
// afterwards. The requirement is "less access than intended, never more", and
// only a failing half can show it.
//
// The records, the reads and the member lists all go through the group's
// stored credential to a fake host (./__fixtures__/stub-pds.ts), which fails a
// half when a case asks. So these cases hold however the transports are wired.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { stubPds } from './__fixtures__/stub-pds';

import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './members-writer';
import {
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember,
	rejectJoinRequest,
	RosterStepError,
	withdrawJoinRequest
} from './roster';

import { pdsSpaceReader } from './about-read';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord
} from '../members-record';
import { DEFAULT_ROLE_PERMISSIONS, type GroupRoleName } from '../permissions';
import { pdsSpaceUpdater } from './spaces';
import { provisionSpacesFor } from './__fixtures__/provisioned-spaces';
import { writeAboutAccess } from './about-writer';
import { pdsWriter } from './group-write';
import { SPACE_MEMBER_ACCESS } from './member-list';
import { rosterFailure } from '../form-error';
import { memberGrant } from './member-grants';
import type { MemberSession } from './acceptance';

import { POLICY_MEMBER_LIST, spaceUri } from '../ids';
import { createGroup, recordGroupSpaces } from './db/groups';
import { addMember, getMemberRow, requestJoin } from './db/roster';
import { getCallerMembership, readStanding } from './standing';
import { groupRouteContext } from './route-context';
import { readMembersOnlyEvents } from './calendar-read';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const NEWCOMER = 'did:plc:newcomeraaaaaaaaaaaaaaaaa';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
const CALENDAR = spaceUri(GROUP_DID, CALENDAR_SPACE_TYPE, 'self');

const HANDLE = 'kona.group.stub.test';
const CRED = linkedCredential(GROUP_DID);

/** The member-list methods, as the step each one adds to `order`. */
const LIST_STEP: Record<string, string> = {
	'com.atproto.simplespace.putMember': 'list:put',
	'com.atproto.simplespace.removeMember': 'list:remove',
	'com.atproto.simplespace.listMembers': 'list:read'
};

/** The space record writes, as the step each one adds to `order`. */
const RECORD_STEP: Record<string, string> = {
	'com.atproto.space.putRecord': 'record:put',
	'com.atproto.space.createRecord': 'record:create',
	'com.atproto.space.deleteRecord': 'record:delete'
};

let harness: SqliteD1;
let group: GroupRow;
/** Every half, in the order the host or D1 saw it: `record:<method>`,
 *  `row:<verb>` and `list:<step>`. */
let order: string[];
/** Set by a case to make the host answer this member-list method with a 502,
 *  on `failListSpace` only when that is set too. */
let failList: string | null;
let failListSpace: string | null;
let pds: ReturnType<typeof stubPds>;
/** Set by a case to make the host answer this record method with a 502. */
let failRecord: string | null;
/** Set by a case to make the host answer a read of this DID's membership
 *  record with a 502. */
let failRead: string | null;
/** How many reads of `failRead` answer before the rest fail. */
let failReadAfter: number;
/** Set by a case to make the host answer a read of this space's access record
 *  with a 502. */
let failAccessSpace: string | null;
/** Set by a case to make the row half throw for matching SQL. */
let failRow: RegExp | null;

let env: ReturnType<typeof linkGroups>;

/** The harness's D1, with the roster's own row writes observable and, when a
 *  case asks, failing. Reads always pass, so the pre-check and the gate see the
 *  real database. */
function rosterDb(): D1Database {
	const db = harness.db;
	return new Proxy(db, {
		get(target, prop, receiver) {
			if (prop !== 'prepare') return Reflect.get(target, prop, receiver);
			return (sql: string) => {
				const verb = /^\s*(DELETE FROM|UPDATE) memberships\b/.exec(sql)?.[1];
				if (!verb) return target.prepare(sql);
				const statement = target.prepare(sql);
				const run = async (bound: D1PreparedStatement) => {
					order.push(`row:${verb === 'UPDATE' ? 'update' : 'delete'}`);
					if (failRow?.test(sql)) throw new Error('D1_ERROR: storage unavailable');
					return bound.run();
				};
				return {
					bind: (...values: unknown[]) => {
						const bound = statement.bind(...values);
						return { ...bound, run: () => run(bound) };
					},
					run: () => run(statement)
				};
			};
		}
	});
}

/** What a route hands an act. The act builds its own reader, writer and
 *  member list from the stored credential. */
function ctx(callerDid: string) {
	return { db: rosterDb(), env, group, callerDid };
}

/** The group's reader, as a request builds it. */
const hostReader = () => pdsSpaceReader(CRED, GROUP_DID);

/** `did`'s membership record as the host holds it, or null, asked straight
 *  from the host and not through the app's reader. */
async function membershipRecord(did: string): Promise<{ value: Record<string, unknown> } | null> {
	const query = new URLSearchParams({
		space: MEMBERS,
		repo: GROUP_DID,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did
	});
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.space.getRecord?${query}`);
	return res.ok ? ((await res.json()) as { value: Record<string, unknown> }) : null;
}

function granted(role: GroupRoleName): string[] {
	return [...DEFAULT_ROLE_PERMISSIONS[role]].sort();
}

async function gate(did: string): Promise<string[]> {
	const membership = await getCallerMembership(harness.db, group, did, hostReader());
	return [...membership.permissions].sort();
}

/** A member-list call, by the space and the DID it names. A query carries them
 *  as parameters, a procedure in its body. */
function memberListCalls() {
	return pds.requests
		.filter((r) => r.nsid in LIST_STEP)
		.map((r) => ({
			nsid: r.nsid,
			space: (r.body?.space as string | undefined) ?? r.params.space,
			did: r.body?.did as string | undefined,
			body: r.body
		}));
}

/** Puts `did` on a space's member list at the host, the way the group's owner
 *  would: straight to the XRPC method, whatever transport the app uses. Every
 *  entry gets the access this app gives a member. */
async function hostPut(space: string, did: string) {
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.simplespace.putMember`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ space, did, ...SPACE_MEMBER_ACCESS })
	});
	expect(res.ok).toBe(true);
}

/** The status of `did`'s latest join request, or null when there is none. */
async function requestStatus(did: string): Promise<string | null> {
	const row = await harness.db
		.prepare(
			`SELECT status FROM join_requests WHERE group_id = ? AND did = ? ORDER BY created_at DESC`
		)
		.bind(group.id, did)
		.first<{ status: string }>();
	return row?.status ?? null;
}

/** Makes the group private the way a settings save narrows it: the about
 *  space's read policy at the host first, then its access record, which is
 *  where the visibility lives. The log is cleared, so a case asserts on its own
 *  act. */
async function makePrivate() {
	await pdsSpaceUpdater(CRED, GROUP_DID)({ space: ABOUT, readPolicy: POLICY_MEMBER_LIST });
	await writeAboutAccess({
		db: harness.db,
		env,
		group,
		callerDid: GROUP_DID,
		visibility: 'private'
	});
	order = [];
	pds.clearLog();
}

/** Rewrites the calendar space's access record to grant `read` to `roles`
 *  only, as an admin of another app could. Through the transport, past no gate. */
async function calendarReadBy(roles: GroupRoleName[]) {
	await pdsWriter(
		CRED,
		GROUP_DID
	)({
		repo: GROUP_DID,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record: {
			...groupAccessRecord({ spaceType: CALENDAR_SPACE_TYPE, roles, public: false }),
			$type: GROUP_ACCESS_COLLECTION
		},
		intent: 'update',
		space: CALENDAR
	});
	order = [];
	pds.clearLog();
}

/** The row and the `group` value both, for a case that needs another shape. */
async function setGroup(changes: { require_approval?: 0 }) {
	const sets = Object.keys(changes).map((column) => `${column} = ?`);
	await harness.db
		.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...Object.values(changes), group.id)
		.run();
	group = { ...group, ...changes };
}

beforeEach(async () => {
	harness = sqliteD1();
	env = linkGroups([GROUP_DID]);
	const db = harness.db;
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');

	order = [];
	failRecord = null;
	failRead = null;
	failReadAfter = 0;
	failAccessSpace = null;
	failRow = null;
	failList = null;
	failListSpace = null;

	// The host: both spaces provisioned through the group's linked session.
	const upstreamFailure = () => Response.json({ error: 'UpstreamFailure' }, { status: 502 });
	pds = stubPds({
		did: GROUP_DID,
		handle: HANDLE,
		fail: (nsid, init, query) => {
			const step = LIST_STEP[nsid] ?? RECORD_STEP[nsid];
			if (step) order.push(step);
			if (nsid === failRecord) return upstreamFailure();
			if (
				nsid === 'com.atproto.space.getRecord' &&
				query?.get('collection') === GROUP_ACCESS_COLLECTION &&
				query?.get('space') === failAccessSpace
			) {
				return upstreamFailure();
			}
			if (nsid === 'com.atproto.space.getRecord' && query?.get('rkey') === failRead) {
				if (failReadAfter > 0) failReadAfter -= 1;
				else return upstreamFailure();
			}
			const space =
				typeof init?.body === 'string'
					? (JSON.parse(init.body) as { space?: string }).space
					: undefined;
			return nsid === failList && (!failListSpace || space === failListSpace)
				? upstreamFailure()
				: undefined;
		}
	});
	// A public group, as a create leaves it: three spaces, and the about
	// space's access record saying public.
	const uris = await provisionSpacesFor(CRED, GROUP_DID, 'public');
	expect(uris).toMatchObject({
		aboutSpaceUri: ABOUT,
		membersSpaceUri: MEMBERS,
		calendarSpaceUri: CALENDAR
	});
	await recordGroupSpaces(db, group.id, uris);
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };

	// Publish the roster, the authz config and the other two spaces' access
	// records, so the gate and the lists resolve from records for the rest of
	// the case. Written as the group itself, which passes every check, as the
	// create writes them. Every role reads every space.
	const seed = { db, env, group, callerDid: GROUP_DID };
	for (const [subject, role] of [
		[OWNER, 'owner'],
		[ADMIN, 'admin'],
		[MEMBER, 'member']
	] as const) {
		await putGroupMembership({ ...seed, subject, roles: [role], intent: 'admit' });
	}
	await writeGroupAuthz(seed);
	await writeGroupAccess(seed);
	await writeGroupAccess({ ...seed, space: CALENDAR });
	// All three lists already hold the roster.
	for (const did of [OWNER, ADMIN, MEMBER]) {
		for (const space of [MEMBERS, ABOUT, CALENDAR]) await hostPut(space, did);
	}
	order = [];
	pds.clearLog();
	expect(await gate(ADMIN)).toEqual(granted('admin'));
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

describe('a revocation takes the record first, then the list entries, then the row', () => {
	// The record is the first write, so its failure changes nothing: a plain
	// failure, with the DID still on the roster and on both lists.
	it('changes nothing when the record delete fails', async () => {
		failRecord = 'com.atproto.space.deleteRecord';
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(RosterStepError);
		expect(order).toEqual(['record:delete']);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect(pds.listed(ABOUT)).toContain(ADMIN);
	});

	// The record, the calendar entry and the about space's entry went, so atmo
	// refuses the DID and the host no longer shows them the group's face. The
	// members space's entry, last, and the row are what a retry finishes.
	it('reports the list out of step when the members space entry cannot be taken off', async () => {
		failList = 'com.atproto.simplespace.removeMember';
		failListSpace = MEMBERS;
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toMatchObject({
			name: 'RosterStepError',
			step: 'list',
			subject: ADMIN,
			change: 'revoke'
		});
		expect(order).toEqual(['record:delete', 'list:remove', 'list:remove', 'list:remove']);
		expect(pds.listed(CALENDAR)).not.toContain(ADMIN);
		expect(pds.listed(ABOUT)).not.toContain(ADMIN);
		expect(pds.listed(MEMBERS)).toContain(ADMIN);
		expect(await membershipRecord(ADMIN)).toBeNull();
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');

		failList = null;
		await ejectMember(ctx(OWNER), ADMIN);
		expect(pds.listed(MEMBERS)).not.toContain(ADMIN);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
	});

	it('leaves the ejected DID with NO grant when the row delete fails after the record went', async () => {
		failRow = /^\s*DELETE FROM memberships/;
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'row' });
		expect((error as RosterStepError).subject).toBe(ADMIN);
		// The row still says admin; the gate believes the record, which is gone.
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await gate(ADMIN)).toEqual([]);
	});

	it('refuses the owner leaving BEFORE any write, and the owner keeps the record', async () => {
		const error = await leaveGroup(ctx(OWNER)).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(order).toEqual([]);
		expect(await membershipRecord(OWNER)).not.toBeNull();
		expect(await gate(OWNER)).toEqual(granted('owner'));
	});

	it('refuses ejecting the owner BEFORE any write, and the owner keeps the record', async () => {
		const error = await ejectMember(ctx(ADMIN), OWNER).catch((e: unknown) => e);
		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(order).toEqual([]);
		expect(await membershipRecord(OWNER)).not.toBeNull();
	});

	it('refuses ejecting a DID that is not on the roster BEFORE any write', async () => {
		const error = await ejectMember(ctx(OWNER), 'did:plc:nobody').catch((e: unknown) => e);
		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'not-found' });
		expect(order).toEqual([]);
	});
});

// An exit has halves at the host and in atmo, and they cannot go at once. The
// record goes first, and atmo's gate reads it, so whichever later half fails,
// atmo never admits a DID the host has stopped admitting. What the host still
// grants, a retry ends.
describe("atmo's gate closes before an exit touches the host", () => {
	const fails = {
		'calendar list entry': () => {
			failList = 'com.atproto.simplespace.removeMember';
			failListSpace = CALENDAR;
		},
		'about list entry': () => {
			failList = 'com.atproto.simplespace.removeMember';
			failListSpace = ABOUT;
		},
		'members list entry': () => {
			failList = 'com.atproto.simplespace.removeMember';
			failListSpace = MEMBERS;
		}
	};

	it.each([
		['an eject', 'calendar list entry', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)],
		['an eject', 'about list entry', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)],
		['an eject', 'members list entry', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)],
		['a leave', 'about list entry', MEMBER, () => leaveGroup(ctx(MEMBER))]
	] as const)(
		'%s whose %s cannot go leaves the DID off the roster, holding nothing',
		async (_act, half, did, act) => {
			fails[half]();

			const error = await act().catch((e: unknown) => e);

			expect(error).toMatchObject({
				name: 'RosterStepError',
				step: 'list',
				subject: did,
				change: 'revoke'
			});
			expect(await membershipRecord(did)).toBeNull();
			const standing = await getCallerMembership(harness.db, group, did, hostReader());
			expect(standing.onRoster).toBe(false);
			expect(standing.permissions.size).toBe(0);
		}
	);

	it("a private group's page and its members-only events refuse an admin whose eject stopped partway", async () => {
		await makePrivate();
		fails['about list entry']();
		await ejectMember(ctx(OWNER), ADMIN).catch(() => {});

		await expect(groupRouteContext(env, harness.db, GROUP_DID, ADMIN)).rejects.toMatchObject({
			status: 404
		});
		const standing = await readStanding(harness.db, group, ADMIN, hostReader());
		expect(await readMembersOnlyEvents(standing, hostReader(), group)).toBeNull();
	});

	it('ejecting again finishes an eject the host refused partway', async () => {
		fails['about list entry']();
		await ejectMember(ctx(OWNER), ADMIN).catch(() => {});
		failList = null;

		await ejectMember(ctx(OWNER), ADMIN);

		for (const space of [MEMBERS, ABOUT, CALENDAR]) expect(pds.listed(space)).not.toContain(ADMIN);
		expect(await membershipRecord(ADMIN)).toBeNull();
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
	});
});

describe('a role change splits by direction', () => {
	it('leaves a failed promotion granting the OLD, smaller set', async () => {
		failRecord = 'com.atproto.space.putRecord';
		const error = await promoteMember(ctx(OWNER), MEMBER, 'admin').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'record' });
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('admin');
		expect(await gate(MEMBER)).toEqual(granted('member'));
	});

	it('leaves a demoted admin with a MEMBER grant when the row write fails', async () => {
		failRow = /^\s*UPDATE memberships/;
		const error = await promoteMember(ctx(OWNER), ADMIN, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'row' });
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect((await membershipRecord(ADMIN))?.value).toMatchObject({ roles: ['member'] });
		expect(await gate(ADMIN)).toEqual(granted('member'));
	});

	it('changes nothing when a demotion cannot write its record', async () => {
		failRecord = 'com.atproto.space.putRecord';
		const error = await promoteMember(ctx(OWNER), ADMIN, 'member').catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(RosterStepError);
		expect(order).toEqual(['record:put']);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await gate(ADMIN)).toEqual(granted('admin'));
	});

	it('refuses demoting the owner BEFORE any write', async () => {
		const error = await promoteMember(ctx(ADMIN), OWNER, 'member').catch((e: unknown) => e);
		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(order).toEqual([]);
		expect(await gate(OWNER)).toEqual(granted('owner'));
	});
});

// A grant reads the member's published join date after its row has moved, so
// the date survives a role change. A read that fails there is the record half
// failing: the row moved and the record did not, and the caller must be told
// the pair is out of step rather than handed a 500 for a committed row.
describe('a grant whose join-date read fails after the row moved', () => {
	it('reports the pair as out of step, with the row in and no record', async () => {
		// Only the newcomer's own membership read fails, after the gate's: the
		// gate reads it first, for the roles the admission would change, and the
		// admitting admin's reads still succeed.
		failRead = NEWCOMER;
		failReadAfter = 1;

		const error = await admitMember(ctx(ADMIN), NEWCOMER, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'record' });
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(pds.writes().some((w) => w.body?.rkey === NEWCOMER)).toBe(false);
		failRead = null;
		expect(await membershipRecord(NEWCOMER)).toBeNull();
	});
});

// An admission is an entry. For a DID already on the roster it would publish
// the requested role over a row that kept its old one, and the gate reads the
// record, so the member would hold a role the roster does not show and that no
// role change granted. It is refused before anything is written, the way a
// direct add of a rostered DID already is.
describe('an admission for a DID already on the roster', () => {
	/** A pending request for `did`, written past `requestJoin`, which answers
	 *  `already-member` for a rostered DID. This is the state a request from
	 *  before a direct add closed requests is left in. */
	async function staleRequest(did: string): Promise<string> {
		const id = crypto.randomUUID();
		await harness.db
			.prepare(
				`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
				 VALUES (?, ?, ?, 'pending', 0, 0)`
			)
			.bind(id, group.id, did)
			.run();
		return id;
	}

	it('approving it is refused, and the row, the record and the list stay as they were', async () => {
		await staleRequest(MEMBER);

		const error = await admitFromRequest(ctx(ADMIN), MEMBER, 'admin').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'constraint' });
		expect(order).toEqual([]);
		expect(memberListCalls()).toEqual([]);
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('member');
		expect((await membershipRecord(MEMBER))?.value).toMatchObject({ roles: ['member'] });
		expect(await gate(MEMBER)).toEqual(granted('member'));
	});

	it('a direct add closes the pending request it answers', async () => {
		expect(await requestJoin(harness.db, group, NEWCOMER, 'hello', 'public')).toBe('pending');

		await admitMember(ctx(ADMIN), NEWCOMER, 'member');

		const request = await harness.db
			.prepare(`SELECT status, decided_by_did FROM join_requests WHERE group_id = ? AND did = ?`)
			.bind(group.id, NEWCOMER)
			.first<{ status: string; decided_by_did: string | null }>();
		expect(request).toEqual({ status: 'approved', decided_by_did: ADMIN });
		expect(
			(await getCallerMembership(harness.db, group, NEWCOMER, hostReader())).pendingRequestId
		).toBeNull();
		expect(await gate(NEWCOMER)).toEqual(granted('member'));
	});
});

// An exit that stopped after its record went leaves a row the records no longer
// back, and so does an admission that stopped before its record was written.
// This site cannot tell the two apart, so it finishes such a row one way only:
// by removing it. A role change or an add would write a fresh record and
// re-admit a member whose removal failed, so both are refused before any write,
// and the eject that finishes the removal makes a plain add possible again.
describe('a member whose removal did not finish', () => {
	/** ADMIN ejected, with the members space entry stuck: the record is gone,
	 *  the row and that list entry stay. */
	async function halfEjected() {
		failList = 'com.atproto.simplespace.removeMember';
		failListSpace = MEMBERS;
		await expect(ejectMember(ctx(OWNER), ADMIN)).rejects.toMatchObject({ step: 'list' });
		failList = null;
		failListSpace = null;
		order = [];
		pds.clearLog();
	}

	it('refuses a role change BEFORE any write, so it cannot re-admit them', async () => {
		await halfEjected();

		const error = await promoteMember(ctx(OWNER), ADMIN, 'admin').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'unfinished-removal' });
		expect(order).toEqual([]);
		expect(memberListCalls().filter((c) => c.nsid.endsWith('putMember'))).toEqual([]);
		expect(await membershipRecord(ADMIN)).toBeNull();
		expect(await gate(ADMIN)).toEqual([]);
	});

	it('refuses an add BEFORE any write, pointing at the removal', async () => {
		await halfEjected();

		const error = await admitMember(ctx(OWNER), ADMIN, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'unfinished-removal' });
		expect((error as Error).message).toMatch(/Remove/);
		expect(order).toEqual([]);
		expect(await membershipRecord(ADMIN)).toBeNull();
	});

	it('lets the eject finish it, and then a plain add admits them again', async () => {
		await halfEjected();

		await ejectMember(ctx(OWNER), ADMIN);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
		expect(pds.listed(MEMBERS)).not.toContain(ADMIN);

		await admitMember(ctx(OWNER), ADMIN, 'member');
		expect(await gate(ADMIN)).toEqual(granted('member'));
	});

	it('still lets a group with no membership records change a role on the rows', async () => {
		// No record anywhere means the records were never written, not that a
		// removal stopped: the rows are the roster, and the change writes the
		// first record.
		for (const did of [OWNER, ADMIN, MEMBER]) {
			await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.space.deleteRecord`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					space: MEMBERS,
					repo: GROUP_DID,
					collection: GROUP_MEMBERSHIP_COLLECTION,
					rkey: did
				})
			});
		}
		expect(await membershipRecord(MEMBER)).toBeNull();

		await promoteMember(ctx(GROUP_DID), MEMBER, 'admin');

		expect((await membershipRecord(MEMBER))?.value).toMatchObject({ roles: ['admin'] });
	});
});

// Each member list follows its space's `access` record: a DID is listed read
// and write on a space exactly when a role its membership names is granted
// `read` there. Under member-list read, that entry is what lets a member read the
// space at the host with their own credential, from any app. So a DID goes on
// the lists its role reads when it enters the roster or changes role, and comes
// off all three when it leaves, for every group whatever its visibility, and in
// the order that errs towards less access: the record first, then the lists.
// (Spec: FR-206, FR-214.)
describe('the member lists follow the access records', () => {
	const putMembers = () =>
		memberListCalls().filter((c) => c.nsid === 'com.atproto.simplespace.putMember');

	/** Each way onto the roster, as the newcomer's arrival. */
	const entries = {
		'an open join': async () => {
			await setGroup({ require_approval: 0 });
			expect(await joinGroup(ctx(NEWCOMER), null)).toBe('joined');
		},
		'a direct add': () => admitMember(ctx(ADMIN), NEWCOMER, 'member')
	};

	// The self-service way on and an admin's, the latter into a private group,
	// since open join exists only for a public one. An admission from a request
	// is the last case of the join-request block below. The members space's entry
	// goes first, so it exists before the member writes their acceptance.
	it.each([
		['an open join', 'public'],
		['a direct add', 'private']
	] as const)(
		'%s into a %s group lists the newcomer on all three spaces, read and write, after the membership record',
		async (act, visibility) => {
			if (visibility === 'private') await makePrivate();

			await entries[act]();

			expect(order).toEqual(['record:put', 'list:put', 'list:put', 'list:put']);
			expect(putMembers().map((c) => c.body)).toEqual([
				{ space: MEMBERS, did: NEWCOMER, ...SPACE_MEMBER_ACCESS },
				{ space: ABOUT, did: NEWCOMER, ...SPACE_MEMBER_ACCESS },
				{ space: CALENDAR, did: NEWCOMER, ...SPACE_MEMBER_ACCESS }
			]);
			for (const space of [MEMBERS, ABOUT, CALENDAR]) {
				expect(pds.members(space)).toContainEqual({ did: NEWCOMER, ...SPACE_MEMBER_ACCESS });
			}
		}
	);

	// The members space's entry comes off last, so the host still accepts the
	// notice of the member's acceptance delete.
	it.each([
		['a leave', MEMBER, () => leaveGroup(ctx(MEMBER))],
		['an eject', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)]
	] as const)(
		'%s deletes its membership record, then takes the DID off all three lists, the members space last',
		async (_act, did, act) => {
			await act();

			expect(order).toEqual([
				'record:delete',
				'list:remove',
				'list:remove',
				'list:remove',
				'row:delete'
			]);
			expect(memberListCalls().map((c) => c.body)).toEqual([
				{ space: CALENDAR, did },
				{ space: ABOUT, did },
				{ space: MEMBERS, did }
			]);
			for (const space of [MEMBERS, ABOUT, CALENDAR]) expect(pds.listed(space)).not.toContain(did);
		}
	);

	// atmo's own records give every role read everywhere, so a role change
	// rewrites the same entries. It lists after the record in both directions:
	// a promotion after the row and record, a demotion before the row.
	it('a role change lists the DID again by its new role, after the record', async () => {
		await promoteMember(ctx(OWNER), MEMBER, 'admin');
		expect(order).toEqual(['row:update', 'record:put', 'list:put', 'list:put', 'list:put']);

		order = [];
		await promoteMember(ctx(OWNER), ADMIN, 'member');
		expect(order).toEqual(['record:put', 'list:put', 'list:put', 'list:put', 'row:update']);

		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.listed(space)).toEqual([OWNER, ADMIN, MEMBER].sort());
			expect(pds.members(space).every((m) => m.read && m.write)).toBe(true);
		}
	});

	// Another app's admin may grant a space to fewer roles. The list follows the
	// record, so the role a member holds decides which spaces they read.
	it('a demotion to a role a space does not grant takes the DID off that space only, and a promotion puts it back', async () => {
		await calendarReadBy(['owner', 'admin']);

		await promoteMember(ctx(OWNER), ADMIN, 'member');

		expect(order).toEqual(['record:put', 'list:put', 'list:put', 'list:remove', 'row:update']);
		expect(pds.listed(CALENDAR)).not.toContain(ADMIN);
		expect(pds.listed(MEMBERS)).toContain(ADMIN);
		expect(pds.listed(ABOUT)).toContain(ADMIN);

		order = [];
		await promoteMember(ctx(OWNER), ADMIN, 'admin');

		expect(order).toEqual(['row:update', 'record:put', 'list:put', 'list:put', 'list:put']);
		expect(pds.members(CALENDAR)).toContainEqual({ did: ADMIN, ...SPACE_MEMBER_ACCESS });
	});

	// A newcomer whose role a space does not grant is never listed there.
	it('an entry lists nothing where the access record does not grant the role', async () => {
		await calendarReadBy(['owner', 'admin']);

		await admitMember(ctx(ADMIN), NEWCOMER, 'member');

		expect(pds.listed(CALENDAR)).not.toContain(NEWCOMER);
		expect(pds.listed(MEMBERS)).toContain(NEWCOMER);
		expect(pds.listed(ABOUT)).toContain(NEWCOMER);
	});

	// The row and the record hold the new role and only the lists lag, so the
	// error says the role changed and Repair brings the lists in line.
	it('a role change whose member-list write fails is reported as a role change out of step', async () => {
		failList = 'com.atproto.simplespace.putMember';

		const error = await promoteMember(ctx(OWNER), MEMBER, 'admin').catch((e: unknown) => e);

		expect(error).toMatchObject({
			name: 'RosterStepError',
			step: 'list',
			subject: MEMBER,
			change: 'assign'
		});
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('admin');
		expect((await membershipRecord(MEMBER))?.value).toMatchObject({ roles: ['admin'] });
		const failure = rosterFailure(error);
		expect(!failure.ok && failure.error).toContain(`${MEMBER}'s role was changed`);
		expect(!failure.ok && failure.error).toContain('Repair this group');
	});

	// The row and the record are in and only the list is missing, so the error
	// names the member whose host access is out of step. Nothing is rolled back:
	// the grant stands, and Repair puts the DID on the list from the record.
	it('a grant whose member-list write fails is reported out of step', async () => {
		failList = 'com.atproto.simplespace.putMember';

		const error = await admitMember(ctx(ADMIN), NEWCOMER, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({
			name: 'RosterStepError',
			step: 'list',
			subject: NEWCOMER,
			change: 'grant'
		});
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(await membershipRecord(NEWCOMER)).not.toBeNull();
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.listed(space)).not.toContain(NEWCOMER);
		}
	});

	// A grant reads the three access records to know where to list. A read that
	// fails leaves the grant in and the lists out of step, never guessed.
	it('a grant whose access records cannot be read lists nobody and is reported out of step', async () => {
		failAccessSpace = CALENDAR;

		const error = await admitMember(ctx(ADMIN), NEWCOMER, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({
			name: 'RosterStepError',
			step: 'list',
			subject: NEWCOMER,
			change: 'grant'
		});
		expect(putMembers()).toEqual([]);
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(await membershipRecord(NEWCOMER)).not.toBeNull();
	});

	// The record went first, so a refused list removal is a later half failing:
	// atmo already refuses the DID, the host still lists them, and the error
	// says the two are out of step.
	it('a revocation whose member-list write fails leaves the host as it was, out of step', async () => {
		failList = 'com.atproto.simplespace.removeMember';

		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'list', change: 'revoke' });
		expect(order).toEqual(['record:delete', 'list:remove']);
		expect(await membershipRecord(ADMIN)).toBeNull();
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		for (const space of [MEMBERS, ABOUT, CALENDAR]) expect(pds.listed(space)).toContain(ADMIN);
	});

	it('owner protection refuses before any member-list write', async () => {
		const eject = await ejectMember(ctx(ADMIN), OWNER).catch((e: unknown) => e);
		const leave = await leaveGroup(ctx(OWNER)).catch((e: unknown) => e);

		expect(eject).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(leave).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(ABOUT)).toContain(OWNER);
	});

	// Reading a space and writing your own records in it are one grant, so every
	// member reads and writes every space their role reads, and no one else is
	// listed. (Spec: FR-206, FR-214, SC-202.)
	it('every member reads and writes each space, and only members are listed', async () => {
		const SECOND = 'did:plc:secondaaaaaaaaaaaaaaaaaa';
		await setGroup({ require_approval: 0 });

		await joinGroup(ctx(NEWCOMER), null);
		await admitMember(ctx(OWNER), SECOND, 'member');
		await leaveGroup(ctx(MEMBER));
		await ejectMember(ctx(OWNER), ADMIN);

		const membersPuts = memberListCalls().filter(
			(c) => c.space === MEMBERS && c.nsid === 'com.atproto.simplespace.putMember'
		);
		expect(membersPuts.map((c) => c.did)).toEqual([NEWCOMER, SECOND]);
		expect(membersPuts.every((c) => c.body?.read === true && c.body?.write === true)).toBe(true);
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.listed(space)).toEqual([OWNER, NEWCOMER, SECOND].sort());
			expect(pds.members(space).every((m) => m.read && m.write)).toBe(true);
		}
	});

	// A group whose about space was never recorded has no list to write. A grant
	// has already moved the row and written the record by then, so it is out of
	// step, and the error says whose.
	it('a grant into a group with no about space is reported out of step', async () => {
		const error = await admitMember(
			{ ...ctx(ADMIN), group: { ...group, about_space_uri: null } },
			NEWCOMER,
			'member'
		).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterStepError', step: 'list', subject: NEWCOMER });
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(await membershipRecord(NEWCOMER)).not.toBeNull();
		expect(memberListCalls()).toEqual([]);
	});
});

// A join request is host state, not a record, and a requester is not a member,
// so a request writes nothing at the group's PDS: no list entry and no
// acceptance. Only the `join_requests` row moves. (Spec: FR-205, FR-206.)
describe('a join request writes nothing at the host', () => {
	it('a request moves only its row', async () => {
		expect(await joinGroup(ctx(NEWCOMER), 'hello')).toBe('pending');

		expect(memberListCalls()).toEqual([]);
		expect(pds.writes()).toEqual([]);
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.listed(space)).not.toContain(NEWCOMER);
		}
		expect(await requestStatus(NEWCOMER)).toBe('pending');
	});

	it.each([
		['withdrawn', () => withdrawJoinRequest(ctx(NEWCOMER))],
		['rejected', () => rejectJoinRequest(ctx(ADMIN), NEWCOMER)]
	] as const)('a request %s moves only its row', async (status, close) => {
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		await close();

		expect(pds.writes()).toEqual([]);
		expect(await requestStatus(NEWCOMER)).toBe(status);
	});

	// A withdrawal names no request, only its caller, so a caller with none of
	// their own cannot reach someone else's.
	it('withdrawing with no request of your own is refused, and the pending one stands', async () => {
		await joinGroup(ctx(NEWCOMER), null);

		const error = await withdrawJoinRequest(ctx(MEMBER)).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'not-found' });
		expect(await requestStatus(NEWCOMER)).toBe('pending');
	});

	// A request is named by its member now, so the lookup can come back empty.
	it('approving or rejecting someone with no pending request is refused as not found', async () => {
		const STRANGER = 'did:plc:strangeraaaaaaaaaaaaaaaaa';
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		for (const act of [
			() => admitFromRequest(ctx(ADMIN), STRANGER, 'member'),
			() => rejectJoinRequest(ctx(ADMIN), STRANGER)
		]) {
			expect(await act().catch((e: unknown) => e)).toMatchObject({
				name: 'GroupRuleError',
				reason: 'not-found'
			});
		}

		expect(await getMemberRow(harness.db, group.id, STRANGER)).toBeNull();
		expect(await requestStatus(NEWCOMER)).toBe('pending');
		expect(pds.writes()).toEqual([]);
	});

	it('a member without ADMIT_MEMBERS cannot reject, and the request stands', async () => {
		await joinGroup(ctx(NEWCOMER), null);

		const error = await rejectJoinRequest(ctx(MEMBER), NEWCOMER).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupPermissionError' });
		expect(await requestStatus(NEWCOMER)).toBe('pending');
	});

	it('a member cannot admit, approve or promote, and no row moves first', async () => {
		const STRANGER = 'did:plc:strangeraaaaaaaaaaaaaaaaa';
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		for (const act of [
			() => admitMember(ctx(MEMBER), STRANGER, 'member'),
			() => admitFromRequest(ctx(MEMBER), NEWCOMER, 'member'),
			() => promoteMember(ctx(MEMBER), MEMBER, 'admin')
		]) {
			expect(await act().catch((e: unknown) => e)).toMatchObject({
				name: 'GroupPermissionError'
			});
		}

		expect(await getMemberRow(harness.db, group.id, STRANGER)).toBeNull();
		expect(await requestStatus(NEWCOMER)).toBe('pending');
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('member');
		expect(pds.writes()).toEqual([]);
	});

	// Approval is when the requester becomes a member, so it is when they are
	// listed: after their membership record, as for any entry.
	it('an approval lists the requester on all three spaces, after their membership record', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		order = [];

		await admitFromRequest(ctx(ADMIN), NEWCOMER, 'member');

		expect(order).toEqual(['record:put', 'list:put', 'list:put', 'list:put']);
		for (const space of [MEMBERS, ABOUT, CALENDAR]) {
			expect(pds.members(space)).toContainEqual({ did: NEWCOMER, ...SPACE_MEMBER_ACCESS });
		}
	});
});

// The caller's own acceptance. Only a member writes one, so a request writes
// none and a withdrawal has none to delete. The member is on the members
// space's list before they write it, so the host tracks the write. At leave it
// is deleted before that entry comes off, because a host that has already
// dropped the writer refuses the notice of the delete, and its writer set would
// keep the old state. Neither half can stop the act: the acceptance decides how
// the roster shows a member, never what they may do.
// (Spec: FR-205, FR-206, FR-209.)
describe('the member writes and deletes their own acceptance', () => {
	/** The caller's session at their own PDS, holding the group's grant. Each
	 *  acceptance call adds a step to `order`, and fails when `fail` is set. */
	function memberSession(did: string, { fail = false } = {}): MemberSession {
		return {
			did,
			scope: memberGrant(GROUP_DID),
			async handle(pathname) {
				const create = pathname === '/xrpc/com.atproto.space.createRecord';
				order.push(create ? 'acceptance:create' : 'acceptance:delete');
				if (fail) return Response.json({ error: 'InternalServerError' }, { status: 500 });
				return Response.json(create ? { uri: `${MEMBERS}/${did}/x/self`, cid: 'bafy' } : {});
			}
		};
	}

	const acceptanceSteps = () => order.filter((step) => step.startsWith('acceptance:'));

	it('an open join lists the member, then they write their acceptance', async () => {
		await setGroup({ require_approval: 0 });

		const outcome = await joinGroup({ ...ctx(NEWCOMER), member: memberSession(NEWCOMER) }, null);

		expect(outcome).toBe('joined');
		expect(order).toEqual(['record:put', 'list:put', 'list:put', 'list:put', 'acceptance:create']);
	});

	it('a request writes no acceptance, though the session holds the grant', async () => {
		const outcome = await joinGroup({ ...ctx(NEWCOMER), member: memberSession(NEWCOMER) }, null);

		expect(outcome).toBe('pending');
		expect(acceptanceSteps()).toEqual([]);
	});

	it('leaving deletes the acceptance before any list entry comes off', async () => {
		await leaveGroup({ ...ctx(MEMBER), member: memberSession(MEMBER) });

		expect(order).toEqual([
			'acceptance:delete',
			'record:delete',
			'list:remove',
			'list:remove',
			'list:remove',
			'row:delete'
		]);
	});

	it('withdrawing deletes no acceptance, since a request wrote none', async () => {
		await joinGroup({ ...ctx(NEWCOMER), member: memberSession(NEWCOMER) }, null);
		order = [];

		await withdrawJoinRequest({ ...ctx(NEWCOMER), member: memberSession(NEWCOMER) });

		expect(acceptanceSteps()).toEqual([]);
		expect(await requestStatus(NEWCOMER)).toBe('withdrawn');
	});

	// Neither half can stop the act: the acceptance decides how the roster shows
	// a member, never what they may do.
	it('a refused acceptance write or delete stops neither the join nor the leave', async () => {
		const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await setGroup({ require_approval: 0 });

		const outcome = await joinGroup(
			{ ...ctx(NEWCOMER), member: memberSession(NEWCOMER, { fail: true }) },
			null
		);
		await leaveGroup({ ...ctx(MEMBER), member: memberSession(MEMBER, { fail: true }) });

		expect(outcome).toBe('joined');
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(pds.members(MEMBERS)).toContainEqual({ did: NEWCOMER, read: true, write: true });
		expect(await getMemberRow(harness.db, group.id, MEMBER)).toBeNull();
		expect(pds.listed(MEMBERS)).not.toContain(MEMBER);
		expect(warned).toHaveBeenCalledTimes(2);
		warned.mockRestore();
	});

	// The session is the caller's, and only their own acts touch it: an admin's
	// eject or reject must not delete the admin's own acceptance. A refused
	// leave stops before it, as before any other write.
	it('an eject, a reject or a refused leave touches no acceptance', async () => {
		await ejectMember({ ...ctx(OWNER), member: memberSession(OWNER) }, ADMIN);
		await joinGroup(ctx(NEWCOMER), null);
		await rejectJoinRequest({ ...ctx(OWNER), member: memberSession(OWNER) }, NEWCOMER);
		await leaveGroup({ ...ctx(OWNER), member: memberSession(OWNER) }).catch(() => {});

		expect(acceptanceSteps()).toEqual([]);
	});
});

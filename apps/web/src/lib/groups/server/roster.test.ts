// The roster acts, and the order their two halves run in.
//
// Every roster act is a D1 row move plus a `membership` record write, and an
// entry or an exit also changes both of the group's member lists at the host. The
// gate resolves from records, so the order decides which way a partial failure
// errs. The rule, by direction of the change:
//
//   * a grant (join, admit, promotion) moves the row first, so the schema
//     decides before anything is published, and a failed record write leaves
//     the old, smaller grant in the record. An entry then puts the DID on the
//     member lists, last;
//   * a revocation (leave, eject, demotion) runs a read-only pre-check, then
//     takes the DID off the member lists (an exit only), then the record, then
//     the row, so a failed later write leaves a record or a list that already
//     grants less.
//
// Each case injects a failure into exactly one half and checks what the gate
// says afterwards. The requirement is "less access than intended, never more",
// and only a failing writer can show it.
//
// The records go through an injected writer and reader. The member list goes
// through the group's stored credential and the fake host
// (./__fixtures__/stub-pds.ts), so these cases hold however the list's
// transport is wired.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { stubPds } from './__fixtures__/stub-pds';
import {
	addMember,
	createGroup,
	getCallerMembership,
	getMemberRow,
	recordGroupSpaces,
	requestJoin
} from './repo';
import { putGroupMembership, writeGroupAuthz } from './members-writer';
import {
	admitFromRequest,
	admitMember,
	ejectMember,
	joinGroup,
	leaveGroup,
	promoteMember,
	rejectJoinRequest,
	RosterRecordError,
	RosterRowError,
	withdrawJoinRequest
} from './roster';
import type { GroupRepoWrite, GroupRepoWriter } from './event-writer';
import { pdsSpaceReader, type GroupSpaceReader } from './about-read';
import {
	STUB_PDS_SERVICE,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
import { DEFAULT_ROLE_PERMISSIONS, type GroupRoleName } from '../permissions';
import { pdsProvisioner, provisionGroupSpaces, spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const NEWCOMER = 'did:plc:newcomeraaaaaaaaaaaaaaaaa';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

const HANDLE = 'kona.group.stub.test';
const CRED = linkedCredential(GROUP_DID);

/** The member-list methods, as the step each one adds to `order`. */
const LIST_STEP: Record<string, string> = {
	'com.atproto.simplespace.putMember': 'list:put',
	'com.atproto.simplespace.removeMember': 'list:remove',
	'com.atproto.simplespace.listMembers': 'list:read'
};

let harness: SqliteD1;
let group: GroupRow;
let writes: GroupRepoWrite[];
/** Every half, in the order it ran: `record:<intent>`, `row:<verb>` and
 *  `list:<step>`. */
let order: string[];
/** Set by a case to make the host answer this member-list method with a 502,
 *  on `failListSpace` only when that is set too. */
let failList: string | null;
let failListSpace: string | null;
let pds: ReturnType<typeof stubPds>;
/** Set by a case to make the record half throw for matching writes. */
let failRecord: ((write: GroupRepoWrite) => boolean) | null;
/** Set by a case to make the row half throw for matching SQL. */
let failRow: RegExp | null;
let writer: GroupRepoWriter;
let reader: GroupSpaceReader;

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

function ctx(callerDid: string) {
	return { db: rosterDb(), env, group, callerDid, writer, reader };
}

function membershipRecord(did: string) {
	return reader.get({
		space: MEMBERS,
		repo: GROUP_DID,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did
	});
}

function granted(role: GroupRoleName): string[] {
	return [...DEFAULT_ROLE_PERMISSIONS[role]].sort();
}

async function gate(did: string): Promise<string[]> {
	const membership = await getCallerMembership(harness.db, group, did, reader);
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
 *  would: straight to the XRPC method, whatever transport the app uses. Each
 *  space's entry gets the access this app gives it. */
async function hostPut(space: string, did: string) {
	const access = space === MEMBERS ? { read: false, write: true } : { read: true, write: false };
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.simplespace.putMember`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ space, did, ...access })
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

/** The id of `did`'s pending join request. */
async function pendingId(did: string): Promise<string> {
	const row = await harness.db
		.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ? AND status = 'pending'`)
		.bind(group.id, did)
		.first<{ id: string }>();
	expect(row).not.toBeNull();
	return row!.id;
}

/** Makes the group private where that lives: its about space's read policy at
 *  the host. */
async function hostPrivate() {
	const res = await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.simplespace.updateSpace`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space: ABOUT,
			readPolicy: { $type: 'com.atproto.simplespace.defs#memberListPolicy' }
		})
	});
	expect(res.ok).toBe(true);
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

	writes = [];
	order = [];
	failRecord = null;
	failRow = null;
	failList = null;
	failListSpace = null;

	// The host: both spaces provisioned through the group's linked session.
	pds = stubPds({
		did: GROUP_DID,
		handle: HANDLE,
		fail: (nsid, init) => {
			if (nsid in LIST_STEP) order.push(LIST_STEP[nsid]);
			const space =
				typeof init?.body === 'string'
					? (JSON.parse(init.body) as { space?: string }).space
					: undefined;
			return nsid === failList && (!failListSpace || space === failListSpace)
				? Response.json({ error: 'UpstreamFailure' }, { status: 502 })
				: undefined;
		}
	});
	const uris = await provisionGroupSpaces(pdsProvisioner(CRED, GROUP_DID), 'public');
	expect(uris).toEqual({ aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });
	await recordGroupSpaces(db, group.id, uris);
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };

	writer = async (write) => {
		order.push(`record:${write.intent}`);
		if (failRecord?.(write)) throw new Error('com.atproto.space.putRecord failed: 502');
		writes.push(write);
		return {
			uri: `${write.space}/${write.repo}/${write.collection}/${write.rkey}`,
			cid: 'bafytest'
		};
	};
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
				cid: 'bafytest',
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

	// Publish the roster and the authz config, so the gate resolves from
	// records for the rest of the case. Memberships first: until the config
	// exists the gate falls back to the rows, which is what authorizes these.
	const seed = { db, env, group, callerDid: OWNER, writer, reader };
	for (const [subject, role] of [
		[OWNER, 'owner'],
		[ADMIN, 'admin'],
		[MEMBER, 'member']
	] as const) {
		await putGroupMembership({ ...seed, subject, roles: [role], intent: 'admit' });
	}
	await writeGroupAuthz(seed);
	// Both lists already hold the roster.
	for (const did of [OWNER, ADMIN, MEMBER]) {
		await hostPut(ABOUT, did);
		await hostPut(MEMBERS, did);
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

describe('a revocation takes the list entry first, then the record', () => {
	it('ejects list-then-record-then-row', async () => {
		await ejectMember(ctx(OWNER), ADMIN);
		expect(order).toEqual(['list:remove', 'list:remove', 'record:delete', 'row:delete']);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
		expect(await membershipRecord(ADMIN)).toBeNull();
	});

	it('leaves list-then-record-then-row', async () => {
		await leaveGroup(ctx(MEMBER));
		expect(order).toEqual(['list:remove', 'list:remove', 'record:delete', 'row:delete']);
		expect(await getMemberRow(harness.db, group.id, MEMBER)).toBeNull();
	});

	// The list entry went and the record did not. The row and the record still
	// agree, and the gate still grants what the record says, but the host no
	// longer lets the DID read the about space: that pair is out of step with
	// the list, and the error says whose.
	it('reports the list out of step when the record delete fails after the list entry went', async () => {
		failRecord = (w) => w.intent === 'delete';
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterListError', subject: ADMIN });
		expect(error).not.toBeInstanceOf(RosterRecordError);
		expect(error).not.toBeInstanceOf(RosterRowError);
		expect(order).toEqual(['list:remove', 'list:remove', 'record:delete']);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect(pds.listed(ABOUT)).not.toContain(ADMIN);
	});

	// Read access went first, so the DID already cannot read the group, and the
	// write-only entry, the record and the row are what a retry finishes.
	it('reports the list out of step when the write-only entry cannot be taken off', async () => {
		failList = 'com.atproto.simplespace.removeMember';
		failListSpace = MEMBERS;
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterListError', subject: ADMIN, change: 'revoke' });
		expect(order).toEqual(['list:remove', 'list:remove']);
		expect(pds.listed(ABOUT)).not.toContain(ADMIN);
		expect(pds.listed(MEMBERS)).toContain(ADMIN);
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');

		failList = null;
		await ejectMember(ctx(OWNER), ADMIN);
		expect(pds.listed(MEMBERS)).not.toContain(ADMIN);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
	});

	it('leaves the ejected DID with NO grant when the row delete fails after the record went', async () => {
		failRow = /^\s*DELETE FROM memberships/;
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RosterRowError);
		expect((error as RosterRowError).subject).toBe(ADMIN);
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

describe('a role change splits by direction', () => {
	it('promotes row-then-record: a grant lets the schema adjudicate first', async () => {
		await promoteMember(ctx(OWNER), MEMBER, 'admin');
		expect(order).toEqual(['row:update', 'record:update']);
		expect(await gate(MEMBER)).toEqual(granted('admin'));
	});

	it('leaves a failed promotion granting the OLD, smaller set', async () => {
		failRecord = (w) => w.intent === 'update';
		const error = await promoteMember(ctx(OWNER), MEMBER, 'admin').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RosterRecordError);
		expect((await getMemberRow(harness.db, group.id, MEMBER))?.role).toBe('admin');
		expect(await gate(MEMBER)).toEqual(granted('member'));
	});

	it('demotes record-then-row: taking a role away is a revocation', async () => {
		await promoteMember(ctx(OWNER), ADMIN, 'member');
		expect(order).toEqual(['record:update', 'row:update']);
		expect(await gate(ADMIN)).toEqual(granted('member'));
	});

	it('leaves a demoted admin with a MEMBER grant when the row write fails', async () => {
		failRow = /^\s*UPDATE memberships/;
		const error = await promoteMember(ctx(OWNER), ADMIN, 'member').catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RosterRowError);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect((await membershipRecord(ADMIN))?.value).toMatchObject({ roles: ['member'] });
		expect(await gate(ADMIN)).toEqual(granted('member'));
	});

	it('changes nothing when a demotion cannot write its record', async () => {
		failRecord = (w) => w.intent === 'update';
		const error = await promoteMember(ctx(OWNER), ADMIN, 'member').catch((e: unknown) => e);

		expect(error).not.toBeInstanceOf(RosterRecordError);
		expect(error).not.toBeInstanceOf(RosterRowError);
		expect(order).toEqual(['record:update']);
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
		const base = reader;
		// Only the newcomer's own membership read fails; the gate's reads for the
		// admitting admin still succeed.
		const failing: GroupSpaceReader = {
			async get(q) {
				if (q.rkey === NEWCOMER) {
					throw new Error('com.atproto.space.getRecord failed: 400 SpaceNotFound');
				}
				return base.get(q);
			},
			list: (q) => base.list(q),
			getSpace: (space) => base.getSpace(space)
		};

		const error = await admitMember({ ...ctx(ADMIN), reader: failing }, NEWCOMER, 'member').catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(RosterRecordError);
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(writes.some((w) => w.rkey === NEWCOMER)).toBe(false);
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
		const request = await staleRequest(MEMBER);

		const error = await admitFromRequest(ctx(ADMIN), request, 'admin').catch((e: unknown) => e);

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
			(await getCallerMembership(harness.db, group, NEWCOMER, reader)).pendingRequestId
		).toBeNull();
		expect(await gate(NEWCOMER)).toEqual(granted('member'));
	});
});

// The about space's member list mirrors the roster. Under member-list read,
// that list is what lets a member read the group's face at the host with their
// own credential, from any app. So a DID goes on it when it enters the roster
// and comes off when it leaves, for every group whatever its visibility, and in
// the order that errs towards less access: an entry writes the record and then
// the list, an exit the list and then the record.
describe('the about space member list mirrors the roster', () => {
	const putMembers = () =>
		memberListCalls().filter((c) => c.nsid === 'com.atproto.simplespace.putMember');

	/** Each way onto the roster, as the newcomer's arrival. */
	const entries = {
		'an open join': async () => {
			await setGroup({ require_approval: 0 });
			expect(await joinGroup(ctx(NEWCOMER), null)).toBe('joined');
		},
		'an admission from a request': async () => {
			expect(await requestJoin(harness.db, group, NEWCOMER, 'hello', 'public')).toBe('pending');
			const request = await harness.db
				.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ?`)
				.bind(group.id, NEWCOMER)
				.first<{ id: string }>();
			await admitFromRequest(ctx(ADMIN), request!.id, 'member');
		},
		'a direct add': () => admitMember(ctx(ADMIN), NEWCOMER, 'member')
	};

	// Open join exists only for a public group, so the private row is a direct
	// add.
	it.each([
		['an open join', 'public'],
		['an admission from a request', 'public'],
		['a direct add', 'public'],
		['a direct add', 'private']
	] as const)(
		'%s into a %s group puts the newcomer on both lists after the membership record',
		async (act, visibility) => {
			if (visibility === 'private') await hostPrivate();

			await entries[act]();

			expect(order).toEqual(['record:update', 'list:put', 'list:put']);
			expect(putMembers().map((c) => c.body)).toEqual([
				{ space: MEMBERS, did: NEWCOMER, read: false, write: true },
				{ space: ABOUT, did: NEWCOMER, read: true, write: false }
			]);
			expect(pds.listed(ABOUT)).toContain(NEWCOMER);
			expect(pds.listed(MEMBERS)).toContain(NEWCOMER);
		}
	);

	it.each([
		['a leave', MEMBER, () => leaveGroup(ctx(MEMBER))],
		['an eject', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)]
	] as const)(
		'%s takes the DID off both lists, read access first, before its membership record',
		async (_act, did, act) => {
			await act();

			expect(order.slice(0, 3)).toEqual(['list:remove', 'list:remove', 'record:delete']);
			expect(memberListCalls().map((c) => c.body)).toEqual([
				{ space: ABOUT, did },
				{ space: MEMBERS, did }
			]);
			expect(pds.listed(ABOUT)).not.toContain(did);
			expect(pds.listed(MEMBERS)).not.toContain(did);
		}
	);

	it('a role change never touches the member list', async () => {
		await promoteMember(ctx(OWNER), MEMBER, 'admin');
		await promoteMember(ctx(OWNER), ADMIN, 'member');

		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([OWNER, ADMIN, MEMBER].sort());
		expect(pds.listed(MEMBERS)).toEqual([OWNER, ADMIN, MEMBER].sort());
	});

	// The row and the record are in and only the list is missing, so the error
	// names the member whose host access is out of step. Nothing is rolled back:
	// the grant stands, and Repair puts the DID on the list from the record.
	it('a grant whose member-list write fails is reported out of step', async () => {
		failList = 'com.atproto.simplespace.putMember';

		const error = await admitMember(ctx(ADMIN), NEWCOMER, 'member').catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterListError', subject: NEWCOMER });
		expect(error).not.toBeInstanceOf(RosterRecordError);
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(await membershipRecord(NEWCOMER)).not.toBeNull();
		expect(pds.listed(ABOUT)).not.toContain(NEWCOMER);
	});

	// The list goes first, so its failure is the first write failing: nothing
	// changed, and it is a plain failure.
	it('a revocation whose member-list write fails changes nothing', async () => {
		failList = 'com.atproto.simplespace.removeMember';

		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).not.toMatch(/^Roster/);
		expect(order).toEqual(['list:remove']);
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(pds.listed(ABOUT)).toContain(ADMIN);
	});

	it('owner protection refuses before any member-list write', async () => {
		const eject = await ejectMember(ctx(ADMIN), OWNER).catch((e: unknown) => e);
		const leave = await leaveGroup(ctx(OWNER)).catch((e: unknown) => e);

		expect(eject).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(leave).toMatchObject({ name: 'GroupRuleError', reason: 'owner-protected' });
		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(ABOUT)).toContain(OWNER);
	});

	// A DID that could read the members space would see every membership, role
	// and permission record straight from the host, so every entry this app
	// puts there is write-only (spec 003 FR-206, SC-202).
	it('the members space list only ever gets write-only entries', async () => {
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
		expect(membersPuts.every((c) => c.body?.read === false && c.body?.write === true)).toBe(true);
		expect(pds.listed(MEMBERS)).toEqual([OWNER, NEWCOMER, SECOND].sort());
		expect(pds.members(MEMBERS).every((m) => !m.read && m.write)).toBe(true);
		expect(pds.listed(ABOUT)).toEqual([OWNER, NEWCOMER, SECOND].sort());
	});

	// The membership record lives in the members space, so its write fails
	// first, and neither list is touched.
	it('a grant into a group with no members space stops before either list', async () => {
		const error = await admitMember(
			{ ...ctx(ADMIN), group: { ...group, members_space_uri: null } },
			NEWCOMER,
			'member'
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(RosterRecordError);
		expect(memberListCalls()).toEqual([]);
	});

	// A group whose about space was never recorded has no list to write. A grant
	// has already moved the row and written the record by then, so it is out of
	// step. A revocation checks first, and fails before it writes anything.
	it('a grant into a group with no about space is reported out of step', async () => {
		const error = await admitMember(
			{ ...ctx(ADMIN), group: { ...group, about_space_uri: null } },
			NEWCOMER,
			'member'
		).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterListError', subject: NEWCOMER });
		expect(await getMemberRow(harness.db, group.id, NEWCOMER)).not.toBeNull();
		expect(await membershipRecord(NEWCOMER)).not.toBeNull();
		expect(memberListCalls()).toEqual([]);
	});

	it('a revocation in a group with no about space fails before any write', async () => {
		const error = await ejectMember(
			{ ...ctx(OWNER), group: { ...group, about_space_uri: null } },
			ADMIN
		).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).not.toMatch(/^Roster/);
		expect(order).toEqual([]);
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
	});
});

// A join requester writes their acceptance at request time (spec 003 FR-206),
// so the host must track their writes before an admin decides. A request is
// host state, not a record, so only the members space's list and the
// `join_requests` row change. The order errs the same way as a roster act: the
// row goes in before the entry, and the entry comes off before the row closes.
describe('a join request holds a write-only entry on the members space list', () => {
	it('a request puts the requester on the members space list only, write-only', async () => {
		expect(await joinGroup(ctx(NEWCOMER), 'hello')).toBe('pending');

		expect(memberListCalls().map((c) => c.body)).toEqual([
			{ space: MEMBERS, did: NEWCOMER, read: false, write: true }
		]);
		expect(pds.listed(ABOUT)).not.toContain(NEWCOMER);
		expect(await requestStatus(NEWCOMER)).toBe('pending');
		expect(order.filter((step) => step.startsWith('record:'))).toEqual([]);
	});

	// The request stands, so the error says the host is out of step with it.
	it('a request whose list write fails is reported out of step, and the request stands', async () => {
		failList = 'com.atproto.simplespace.putMember';

		const error = await joinGroup(ctx(NEWCOMER), null).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'RosterListError', subject: NEWCOMER, change: 'request' });
		expect(await requestStatus(NEWCOMER)).toBe('pending');
		expect(pds.listed(MEMBERS)).not.toContain(NEWCOMER);
	});

	it('a request refused by the rules writes nothing to the list', async () => {
		const outcome = await joinGroup(ctx(MEMBER), null);

		expect(outcome).toBe('already-member');
		expect(memberListCalls()).toEqual([]);
	});

	it('withdrawing takes the entry off, then closes the request', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		await withdrawJoinRequest(ctx(NEWCOMER), await pendingId(NEWCOMER));

		expect(memberListCalls().map((c) => c.body)).toEqual([{ space: MEMBERS, did: NEWCOMER }]);
		expect(pds.listed(MEMBERS)).not.toContain(NEWCOMER);
		expect(await requestStatus(NEWCOMER)).toBe('withdrawn');
	});

	// The entry goes first, so its failure is the first write failing.
	it('a withdrawal whose list removal fails leaves the request pending', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		failList = 'com.atproto.simplespace.removeMember';

		const error = await withdrawJoinRequest(ctx(NEWCOMER), await pendingId(NEWCOMER)).catch(
			(e: unknown) => e
		);

		expect(error).toBeInstanceOf(Error);
		expect(await requestStatus(NEWCOMER)).toBe('pending');
		expect(pds.listed(MEMBERS)).toContain(NEWCOMER);
	});

	it("withdrawing someone else's request is refused before any write", async () => {
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		const error = await withdrawJoinRequest(ctx(MEMBER), await pendingId(NEWCOMER)).catch(
			(e: unknown) => e
		);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'not-found' });
		expect(memberListCalls()).toEqual([]);
		expect(await requestStatus(NEWCOMER)).toBe('pending');
	});

	it('rejecting takes the entry off, then closes the request', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		await rejectJoinRequest(ctx(ADMIN), await pendingId(NEWCOMER));

		expect(memberListCalls().map((c) => c.body)).toEqual([{ space: MEMBERS, did: NEWCOMER }]);
		expect(pds.listed(MEMBERS)).not.toContain(NEWCOMER);
		expect(await requestStatus(NEWCOMER)).toBe('rejected');
	});

	it('a member without ADMIT_MEMBERS cannot reject, and nothing is written', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		pds.clearLog();

		const error = await rejectJoinRequest(ctx(MEMBER), await pendingId(NEWCOMER)).catch(
			(e: unknown) => e
		);

		expect(error).toMatchObject({ name: 'GroupPermissionError' });
		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(MEMBERS)).toContain(NEWCOMER);
		expect(await requestStatus(NEWCOMER)).toBe('pending');
	});

	it('rejecting a request that is no longer pending is refused before any write', async () => {
		await joinGroup(ctx(NEWCOMER), null);
		const id = await pendingId(NEWCOMER);
		await admitFromRequest(ctx(ADMIN), id, 'member');
		pds.clearLog();

		const error = await rejectJoinRequest(ctx(ADMIN), id).catch((e: unknown) => e);

		expect(error).toMatchObject({ name: 'GroupRuleError', reason: 'not-found' });
		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(MEMBERS)).toContain(NEWCOMER);
	});

	// The admission puts the entry again, an upsert, so a requester whose
	// request-time put failed is listed once admitted.
	it('an admission lists the requester on both spaces, whatever the request left', async () => {
		failList = 'com.atproto.simplespace.putMember';
		await joinGroup(ctx(NEWCOMER), null).catch(() => {});
		failList = null;

		await admitFromRequest(ctx(ADMIN), await pendingId(NEWCOMER), 'member');

		expect(pds.members(MEMBERS)).toContainEqual({ did: NEWCOMER, read: false, write: true });
		expect(pds.listed(ABOUT)).toContain(NEWCOMER);
	});
});

// The roster acts, and the order their two halves run in.
//
// Every roster act is a D1 row move plus a `membership` record write, and an
// entry or an exit also changes the about space's member list at the host. The
// gate resolves from records, so the order decides which way a partial failure
// errs. The rule, by direction of the change:
//
//   * a grant (join, admit, promotion) moves the row first, so the schema
//     decides before anything is published, and a failed record write leaves
//     the old, smaller grant in the record. An entry then puts the DID on the
//     member list, last;
//   * a revocation (leave, eject, demotion) runs a read-only pre-check, then
//     takes the DID off the member list (an exit only), then the record, then
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
	RosterRecordError,
	RosterRowError
} from './roster';
import type { GroupRepoWrite, GroupRepoWriter } from './event-writer';
import { pdsSpaceReader, type GroupSpaceReader } from './about-read';
import { storeGroupCredential, type GroupCredential } from './credentials';
import { clearGroupSessions } from './session';
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

/** 32 bytes, base64: the credential store accepts nothing shorter. */
const KEY = btoa('0123456789abcdef0123456789abcdef');
const CRED: GroupCredential = {
	service: 'https://pds.stub.test',
	identifier: 'kona.group.stub.test',
	password: 'app-pass-1234'
};

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
/** Set by a case to make the host answer this member-list method with a 502. */
let failList: string | null;
let pds: ReturnType<typeof stubPds>;
/** Set by a case to make the record half throw for matching writes. */
let failRecord: ((write: GroupRepoWrite) => boolean) | null;
/** Set by a case to make the row half throw for matching SQL. */
let failRow: RegExp | null;
let writer: GroupRepoWriter;
let reader: GroupSpaceReader;

const env = { GROUP_CREDENTIAL_KEY: KEY };

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
 *  would: straight to the XRPC method, whatever transport the app uses. */
async function hostPut(space: string, did: string) {
	const res = await fetch(`${CRED.service}/xrpc/com.atproto.simplespace.putMember`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ space, did, read: true, write: false })
	});
	expect(res.ok).toBe(true);
}

/** The row and the `group` value both, for a case that needs another shape. */
async function setGroup(changes: { visibility?: 'private'; require_approval?: 0 }) {
	const sets = Object.keys(changes).map((column) => `${column} = ?`);
	await harness.db
		.prepare(`UPDATE groups SET ${sets.join(', ')} WHERE id = ?`)
		.bind(...Object.values(changes), group.id)
		.run();
	group = { ...group, ...changes };
}

beforeEach(async () => {
	harness = sqliteD1();
	clearGroupSessions();
	const db = harness.db;
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');

	writes = [];
	order = [];
	failRecord = null;
	failRow = null;
	failList = null;

	// The host: both spaces provisioned under the group's stored credential.
	pds = stubPds({
		did: GROUP_DID,
		handle: CRED.identifier,
		fail: (nsid) => {
			if (nsid in LIST_STEP) order.push(LIST_STEP[nsid]);
			return nsid === failList
				? Response.json({ error: 'UpstreamFailure' }, { status: 502 })
				: undefined;
		}
	});
	await storeGroupCredential(env, db, GROUP_DID, CRED);
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
	// The about space's list already holds the roster.
	for (const did of [OWNER, ADMIN, MEMBER]) await hostPut(ABOUT, did);
	order = [];
	pds.clearLog();
	expect(await gate(ADMIN)).toEqual(granted('admin'));
});

afterEach(() => {
	vi.unstubAllGlobals();
	clearGroupSessions();
	harness.close();
});

describe('a revocation takes the list entry first, then the record', () => {
	it('ejects list-then-record-then-row', async () => {
		await ejectMember(ctx(OWNER), ADMIN);
		expect(order).toEqual(['list:remove', 'record:delete', 'row:delete']);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
		expect(await membershipRecord(ADMIN)).toBeNull();
	});

	it('leaves list-then-record-then-row', async () => {
		await leaveGroup(ctx(MEMBER));
		expect(order).toEqual(['list:remove', 'record:delete', 'row:delete']);
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
		expect(order).toEqual(['list:remove', 'record:delete']);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await membershipRecord(ADMIN)).not.toBeNull();
		expect(pds.listed(ABOUT)).not.toContain(ADMIN);
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
		'%s into a %s group puts the newcomer on the list after the membership record',
		async (act, visibility) => {
			if (visibility === 'private') await setGroup({ visibility: 'private' });

			await entries[act]();

			expect(order).toEqual(['record:update', 'list:put']);
			expect(putMembers().map((c) => c.body)).toEqual([
				{ space: ABOUT, did: NEWCOMER, read: true, write: false }
			]);
			expect(pds.listed(ABOUT)).toContain(NEWCOMER);
		}
	);

	it.each([
		['a leave', MEMBER, () => leaveGroup(ctx(MEMBER))],
		['an eject', ADMIN, () => ejectMember(ctx(OWNER), ADMIN)]
	] as const)(
		'%s takes the DID off the list before its membership record',
		async (_act, did, act) => {
			await act();

			expect(order.slice(0, 2)).toEqual(['list:remove', 'record:delete']);
			expect(memberListCalls().map((c) => c.body)).toEqual([{ space: ABOUT, did }]);
			expect(pds.listed(ABOUT)).not.toContain(did);
		}
	);

	it('a role change never touches the member list', async () => {
		await promoteMember(ctx(OWNER), MEMBER, 'admin');
		await promoteMember(ctx(OWNER), ADMIN, 'member');

		expect(memberListCalls()).toEqual([]);
		expect(pds.listed(ABOUT)).toEqual([OWNER, ADMIN, MEMBER].sort());
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

	// A DID on the members space's list could read every membership, role and
	// permission record straight from the host, so that list stays empty
	// whatever the roster does.
	it('the members space list is never written', async () => {
		const SECOND = 'did:plc:secondaaaaaaaaaaaaaaaaaa';
		await setGroup({ require_approval: 0 });

		await joinGroup(ctx(NEWCOMER), null);
		await admitMember(ctx(OWNER), SECOND, 'member');
		await leaveGroup(ctx(MEMBER));
		await ejectMember(ctx(OWNER), ADMIN);

		expect(memberListCalls().filter((c) => c.space !== ABOUT)).toEqual([]);
		expect(pds.listed(MEMBERS)).toEqual([]);
		// And the acts did reach the about space's list, so the check above is
		// not passing on silence.
		expect(pds.listed(ABOUT)).toEqual([OWNER, NEWCOMER, SECOND].sort());
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

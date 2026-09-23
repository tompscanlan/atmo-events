// The roster acts, and the ORDER their two halves run in.
//
// Every roster act is a D1 row move plus a `membership` record write, and since
// the gate resolves from records (T016) the order decides which way a partial
// failure errs. The rule, by direction of the change (FR-006):
//
//   * a GRANT (join, admit, promotion) moves the row first — the schema
//     adjudicates before anything is published — so a failed record write
//     leaves the old, smaller grant in the record;
//   * a REVOCATION (leave, eject, demotion) runs a read-only pre-check, then the
//     record, then the row — so a failed row write leaves a record that already
//     grants less.
//
// Every case here injects a failure into exactly one half and asserts what the
// gate says afterwards. "Less access than intended, never more" is the whole
// acceptance, and only a failing writer can show it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	addMember,
	createGroup,
	getCallerMembership,
	getMemberRow,
	recordGroupSpaces
} from './repo';
import { putGroupMembership, writeGroupAuthz } from './members-writer';
import {
	ejectMember,
	leaveGroup,
	promoteMember,
	RosterRecordError,
	RosterRowError
} from './roster';
import type { GroupRepoWrite, GroupRepoWriter } from './event-writer';
import type { GroupSpaceReader } from './about-read';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
import { DEFAULT_ROLE_PERMISSIONS, type GroupRoleName } from '../permissions';
import { spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

let harness: SqliteD1;
let group: GroupRow;
let writes: GroupRepoWrite[];
/** Both halves, in the order they ran: `record:<intent>` and `row:<verb>`. */
let order: string[];
/** Set by a case to make the record half throw for matching writes. */
let failRecord: ((write: GroupRepoWrite) => boolean) | null;
/** Set by a case to make the row half throw for matching SQL. */
let failRow: RegExp | null;
let writer: GroupRepoWriter;
let reader: GroupSpaceReader;

const env = {};

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

beforeEach(async () => {
	harness = sqliteD1();
	const db = harness.db;
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');
	await recordGroupSpaces(db, group.id, { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });
	group = { ...group, about_space_uri: ABOUT, members_space_uri: MEMBERS };

	writes = [];
	order = [];
	failRecord = null;
	failRow = null;
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
		}
	};

	// Publish the roster and the authz config, so the gate resolves from
	// RECORDS for the rest of the case. Memberships first: until the config
	// exists the gate falls back to the rows, which is what authorises these.
	const seed = { db, env, group, callerDid: OWNER, writer, reader };
	for (const [subject, role] of [
		[OWNER, 'owner'],
		[ADMIN, 'admin'],
		[MEMBER, 'member']
	] as const) {
		await putGroupMembership({ ...seed, subject, roles: [role], intent: 'admit' });
	}
	await writeGroupAuthz(seed);
	order = [];
	expect(await gate(ADMIN)).toEqual(granted('admin'));
});

afterEach(() => harness.close());

describe('a revocation writes the record first (FR-006)', () => {
	it('ejects record-then-row', async () => {
		await ejectMember(ctx(OWNER), ADMIN);
		expect(order).toEqual(['record:delete', 'row:delete']);
		expect(await getMemberRow(harness.db, group.id, ADMIN)).toBeNull();
		expect(await membershipRecord(ADMIN)).toBeNull();
	});

	it('leaves record-then-row', async () => {
		await leaveGroup(ctx(MEMBER));
		expect(order).toEqual(['record:delete', 'row:delete']);
		expect(await getMemberRow(harness.db, group.id, MEMBER)).toBeNull();
	});

	it('changes nothing when the record delete fails, and says so as a plain failure', async () => {
		failRecord = (w) => w.intent === 'delete';
		const error = await ejectMember(ctx(OWNER), ADMIN).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(Error);
		// Nothing moved, so neither out-of-step report is true.
		expect(error).not.toBeInstanceOf(RosterRecordError);
		expect(error).not.toBeInstanceOf(RosterRowError);
		expect(order).toEqual(['record:delete']);
		expect((await getMemberRow(harness.db, group.id, ADMIN))?.role).toBe('admin');
		expect(await membershipRecord(ADMIN)).not.toBeNull();
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

describe('a role change splits by direction (FR-006)', () => {
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

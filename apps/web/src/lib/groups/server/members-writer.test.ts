// The roster writer, and the gate in front of it.
//
// The case that earns its place here is the SELF-SERVICE pair. `join` and
// `leave` are the only two roster writes authorised by identity rather than by
// a grant, so if the identity check were ever dropped they would become an
// unguarded admit and an unguarded eject — reachable by any signed-in caller,
// against any subject, with no permission at all. That is not a refactor
// hazard in theory: a plain member holds none of the three roster grants, which
// is exactly why the branch exists and exactly why it is easy to "simplify" it
// into a permission check that happens to pass for admins.
//
// The rest asserts where the records LAND (the members space, authored by the
// group) and that suspension revokes rather than annotates.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import {
	dropGroupMembership,
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz
} from './members-writer';
import {
	GroupPermissionError,
	GroupRecordError,
	type GroupRepoWrite,
	type GroupRepoWriter
} from './event-writer';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION
} from '../members-record';
import type { GroupSpaceReader } from './about-read';
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
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;
/** Reads back what `writer` wrote, so the gate resolves from the same members
 *  space the test is writing into (T016). It starts empty — no authz config —
 *  so the gate falls back to the roster rows `addMember` seeded. */
let reader: GroupSpaceReader;

// The writers take an env only to resolve a credential, and every case here
// injects its own transport, so it is never consulted.
const env = {};

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

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return {
			uri: `${write.space}/${write.repo}/${write.collection}/${write.rkey}`,
			cid: 'bafytest'
		};
	};
	// The latest write per (space, collection, rkey) wins, and a delete removes.
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
});

afterEach(() => harness.close());

describe('putGroupMembership', () => {
	it('writes into the MEMBERS space, authored by the group, keyed by the member DID', async () => {
		const result = await putGroupMembership({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			subject: STRANGER,
			roles: ['member'],
			intent: 'admit'
		});

		expect(writes).toHaveLength(1);
		expect(writes[0].space).toBe(MEMBERS);
		expect(writes[0].repo).toBe(GROUP_DID);
		expect(writes[0].collection).toBe(GROUP_MEMBERSHIP_COLLECTION);
		expect(writes[0].rkey).toBe(STRANGER);
		// `putRecord`, so a role change rewrites one record instead of stacking a
		// second one under a new key.
		expect(writes[0].intent).toBe('update');
		expect(result.rkey).toBe(STRANGER);
	});

	it('refuses an admit by a member who holds no ADMIT_MEMBERS', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				reader,
				subject: STRANGER,
				roles: ['member'],
				intent: 'admit'
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	it('refuses a role change by a member who holds no ASSIGN_ROLES', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				reader,
				subject: MEMBER,
				roles: ['admin'],
				intent: 'assign'
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	it('refuses a membership that would grant no role at all', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group,
				callerDid: OWNER,
				writer,
				reader,
				subject: STRANGER,
				roles: [],
				intent: 'admit'
			})
		).rejects.toThrow(GroupRecordError);
	});

	it('refuses to write before the members space exists', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group: { ...group, members_space_uri: null },
				callerDid: OWNER,
				writer,
				reader,
				subject: STRANGER,
				roles: ['member'],
				intent: 'admit'
			})
		).rejects.toThrow(GroupRecordError);
		expect(writes).toHaveLength(0);
	});
});

describe('the self-service intents', () => {
	it('lets a plain member record their own join, holding no grant', async () => {
		await putGroupMembership({
			db,
			env,
			group,
			callerDid: MEMBER,
			writer,
			reader,
			subject: MEMBER,
			roles: ['member'],
			intent: 'join'
		});
		expect(writes[0].rkey).toBe(MEMBER);
	});

	it('refuses a join recorded FOR somebody else, which would be an unguarded admit', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				reader,
				subject: STRANGER,
				roles: ['member'],
				intent: 'join'
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	it('lets a plain member revoke their own membership record', async () => {
		await dropGroupMembership({
			db,
			env,
			group,
			callerDid: MEMBER,
			writer,
			reader,
			subject: MEMBER,
			intent: 'leave'
		});
		expect(writes[0].intent).toBe('delete');
		expect(writes[0].rkey).toBe(MEMBER);
	});

	it('refuses a leave aimed at somebody else, which would be an unguarded eject', async () => {
		await expect(
			dropGroupMembership({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				reader,
				subject: ADMIN,
				intent: 'leave'
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	it('refuses a leave from an anonymous caller', async () => {
		await expect(
			dropGroupMembership({
				db,
				env,
				group,
				callerDid: null,
				writer,
				reader,
				subject: MEMBER,
				intent: 'leave'
			})
		).rejects.toThrow(GroupPermissionError);
	});
});

describe('dropGroupMembership', () => {
	it('deletes the record for an eject, which is how access is revoked', async () => {
		await dropGroupMembership({
			db,
			env,
			group,
			callerDid: ADMIN,
			writer,
			reader,
			subject: MEMBER,
			intent: 'eject'
		});
		expect(writes[0]).toMatchObject({
			space: MEMBERS,
			repo: GROUP_DID,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: MEMBER,
			intent: 'delete'
		});
	});

	it('deletes it for a suspension too: a suspended member holds no grant', async () => {
		await dropGroupMembership({
			db,
			env,
			group,
			callerDid: ADMIN,
			writer,
			reader,
			subject: MEMBER,
			intent: 'suspend'
		});
		expect(writes[0].intent).toBe('delete');
	});

	it('refuses an eject by a member who holds no EJECT_MEMBERS', async () => {
		await expect(
			dropGroupMembership({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				reader,
				subject: ADMIN,
				intent: 'eject'
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

describe('writeGroupAccess', () => {
	it('writes the members space read policy as a self-keyed record', async () => {
		await writeGroupAccess({ db, env, group, callerDid: OWNER, writer, reader });
		expect(writes[0]).toMatchObject({
			space: MEMBERS,
			repo: GROUP_DID,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY,
			intent: 'update'
		});
		expect(writes[0].record.roles).toEqual(['owner', 'admin', 'member']);
	});

	it('needs MANAGE_GROUP: the space policy is configuration, not a roster act', async () => {
		await expect(
			writeGroupAccess({ db, env, group, callerDid: ADMIN, writer, reader })
		).resolves.toBeDefined();
		await expect(
			writeGroupAccess({ db, env, group, callerDid: MEMBER, writer, reader })
		).rejects.toThrow(GroupPermissionError);
	});
});

describe('writeGroupAuthz', () => {
	it('writes a role record per role, then both binding records, all into the members space', async () => {
		await writeGroupAuthz({ db, env, group, callerDid: OWNER, writer, reader });

		expect(writes.map((write) => `${write.collection}/${write.rkey}`)).toEqual([
			`${GROUP_ROLE_COLLECTION}/owner`,
			`${GROUP_ROLE_COLLECTION}/admin`,
			`${GROUP_ROLE_COLLECTION}/member`,
			`${GROUP_PERMISSIONS_COLLECTION}/self`,
			`${GROUP_EVENT_PERMISSIONS_COLLECTION}/self`
		]);
		expect(writes.every((write) => write.space === MEMBERS && write.repo === GROUP_DID)).toBe(true);
		// Puts, not creates: the keys are fixed, so re-running repairs rather
		// than duplicating.
		expect(writes.every((write) => write.intent === 'update')).toBe(true);
	});

	// THE ESCALATION THIS GATE EXISTS FOR. The permissions record IS the authz
	// config: a member who could write it could bind their own role to
	// ASSIGN_ROLES and own the group. It is configuration, so it is
	// MANAGE_GROUP — the same answer the profile, the rules and the access
	// record give.
	it('needs MANAGE_GROUP, so a plain member cannot rewrite the group’s own grants', async () => {
		await expect(
			writeGroupAuthz({ db, env, group, callerDid: MEMBER, writer, reader })
		).rejects.toThrow(GroupPermissionError);
		await expect(
			writeGroupAuthz({ db, env, group, callerDid: STRANGER, writer, reader })
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toEqual([]);
	});

	it('publishes the standard’s identifiers for the community four and ours for the event two', async () => {
		await writeGroupAuthz({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			// A group-defined bundle: the point of roles-as-data is that this
			// needs no deploy. A greeter who may admit and create events holds
			// one action in each record.
			bundles: { member: ['ADMIT_MEMBERS', 'CREATE_EVENT'] }
		});

		expect(writes.map((write) => write.rkey)).toEqual(['member', 'self', 'self']);
		expect(writes[1].record.bindings).toEqual([{ role: 'member', actions: ['admit'] }]);
		expect(writes[2].record.bindings).toEqual([{ role: 'member', actions: ['createEvent'] }]);
	});
});

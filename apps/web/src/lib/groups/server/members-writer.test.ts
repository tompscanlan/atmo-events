// The roster writer, and the gate in front of it.
//
// The most important cases are the self-service pair. `join` and `leave` are
// the only roster writes authorized by identity rather than by a grant. If the
// identity check were dropped, they would become an unguarded admit and an
// unguarded eject: any signed-in caller, any subject, no permission needed. A
// plain member holds none of the three roster grants, which is why the branch
// exists, and why it is easy to "simplify" it into a permission check that
// happens to pass for admins.
//
// The other cases check where the records go (the members space, authored by
// the group), and that the calendar space gets its access record and index entry
// only from a caller that names it: create does, repair does not.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';

import {
	dropGroupMembership,
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from './members-writer';

import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION
} from '../members-record';
import type { GroupSpaceReader } from './about-read';

import { spaceUri } from '../ids';
import {
	GroupPermissionError,
	GroupRecordError,
	type GroupRepoWrite,
	type GroupRepoWriter
} from './group-write';
import { createGroup, recordGroupSpaces } from './db/groups';
import { addMember } from './db/roster';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
/** Written out, so a wrong type in the constant cannot pass by agreeing with itself. */
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;
/** Reads back what `writer` wrote, so the gate resolves from the same members
 *  space the test writes into. It starts empty (no authz config), so the gate
 *  falls back to the roster rows `addMember` seeded. */
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
		},
		async getSpace() {
			throw new Error('this fake holds records, not a space configuration');
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

	it('refuses to write into a members space of another type', async () => {
		await expect(
			putGroupMembership({
				db,
				env,
				group: {
					...group,
					members_space_uri: `at://${group.group_did}/space/com.example.other/self`
				},
				callerDid: OWNER,
				writer,
				reader,
				subject: STRANGER,
				roles: ['member'],
				intent: 'admit'
			})
		).rejects.toThrow(/is not .*'s members space/);
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
		expect(writes[0].record).toEqual({
			$type: GROUP_ACCESS_COLLECTION,
			public: false,
			readRoles: ['owner', 'admin', 'member'],
			grants: []
		});
	});

	it('needs MANAGE_GROUP: the space policy is configuration, not a roster act', async () => {
		await expect(
			writeGroupAccess({ db, env, group, callerDid: ADMIN, writer, reader })
		).resolves.toBeDefined();
		await expect(
			writeGroupAccess({ db, env, group, callerDid: MEMBER, writer, reader })
		).rejects.toThrow(GroupPermissionError);
	});

	// The calendar space's access record says what the members space's says:
	// not public, read by the members' roles. Only the target changes.
	it('writes the same access record into the calendar space when the caller names it', async () => {
		expect(spaceUri(GROUP_DID, CALENDAR_SPACE_TYPE, 'self')).toBe(CALENDAR);

		await writeGroupAccess({ db, env, group, callerDid: OWNER, writer, reader, space: CALENDAR });

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			space: CALENDAR,
			repo: GROUP_DID,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY,
			intent: 'update'
		});
		expect(writes[0].record).toEqual({
			$type: GROUP_ACCESS_COLLECTION,
			public: false,
			readRoles: ['owner', 'admin', 'member'],
			grants: []
		});
	});

	// `public: false` written into the about space of a public group would
	// contradict its read policy. That record is writeAboutAccess's alone.
	it.each([
		['the about space', ABOUT],
		["another group's calendar space", 'at://did:plc:other/space/net.openmeet.space.calendar/self'],
		['a space of another type', `at://${GROUP_DID}/space/com.example.other/self`]
	])('refuses to write it into %s', async (_case, space) => {
		await expect(
			writeGroupAccess({ db, env, group, callerDid: OWNER, writer, reader, space })
		).rejects.toThrow(GroupRecordError);
		expect(writes).toHaveLength(0);
	});

	it('needs MANAGE_GROUP for the calendar space too', async () => {
		await expect(
			writeGroupAccess({ db, env, group, callerDid: MEMBER, writer, reader, space: CALENDAR })
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

describe('writeGroupSpaceIndex', () => {
	const indexWrites = () => writes.filter((w) => w.collection === GROUP_SPACE_COLLECTION);
	const entry = (rkey: string, space: string) => ({ rkey, space });

	// Repair's call. Repair leaves the calendar space to the first members-only
	// write, so without the calendar space the index is the two spaces it always was.
	it('indexes the about and members spaces only when no calendar space is passed', async () => {
		const result = await writeGroupSpaceIndex({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			existing: []
		});

		expect(result).toEqual({ added: [ABOUT, MEMBERS], removed: [] });
		expect(indexWrites().map((w) => w.record.space)).toEqual([ABOUT, MEMBERS]);
		expect(writes.some((w) => w.space === CALENDAR)).toBe(false);
	});

	// Create's call: three spaces, one entry each, all in the members space.
	it('indexes the calendar space as a third entry when the caller passes it', async () => {
		const result = await writeGroupSpaceIndex({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			existing: [],
			calendarSpace: CALENDAR,
			createdAt: '2026-10-06T12:00:00.000Z'
		});

		expect(result).toEqual({ added: [ABOUT, MEMBERS, CALENDAR], removed: [] });
		expect(indexWrites()).toHaveLength(3);
		for (const write of indexWrites()) {
			expect(write).toMatchObject({ space: MEMBERS, repo: GROUP_DID, intent: 'create' });
		}
		expect(indexWrites()[2].record).toEqual({
			$type: GROUP_SPACE_COLLECTION,
			space: CALENDAR,
			createdAt: '2026-10-06T12:00:00.000Z'
		});
		expect(new Set(indexWrites().map((w) => w.rkey)).size).toBe(3);
	});

	it('adds nothing when each of the three spaces already has its entry', async () => {
		const result = await writeGroupSpaceIndex({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			existing: [
				entry('3m2aaaaaaaaa2', ABOUT),
				entry('3m2aaaaaaaaa3', MEMBERS),
				entry('3m2aaaaaaaaa4', CALENDAR)
			],
			calendarSpace: CALENDAR
		});

		expect(result).toEqual({ added: [], removed: [] });
		expect(writes).toEqual([]);
	});

	// The keep-oldest rule holds per space, the calendar space included, so two
	// creates racing leave one entry each.
	it('keeps the oldest calendar entry and deletes the younger ones', async () => {
		const result = await writeGroupSpaceIndex({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			existing: [
				entry('3m2aaaaaaaaa7', CALENDAR),
				entry('3m2aaaaaaaaa2', ABOUT),
				entry('3m2aaaaaaaaa3', MEMBERS),
				entry('3m2aaaaaaaaa4', CALENDAR),
				entry('3m2aaaaaaaaa5', CALENDAR)
			],
			calendarSpace: CALENDAR
		});

		expect(result).toEqual({ added: [], removed: ['3m2aaaaaaaaa5', '3m2aaaaaaaaa7'] });
		expect(indexWrites().map((w) => [w.intent, w.rkey])).toEqual([
			['delete', '3m2aaaaaaaaa5'],
			['delete', '3m2aaaaaaaaa7']
		]);
	});

	// Repair on a group made after this build: its calendar entries are another
	// space's as far as repair is concerned, so even duplicates stay.
	it('leaves calendar entries alone when the caller does not pass the calendar space', async () => {
		const result = await writeGroupSpaceIndex({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			existing: [
				entry('3m2aaaaaaaaa2', ABOUT),
				entry('3m2aaaaaaaaa3', MEMBERS),
				entry('3m2aaaaaaaaa4', CALENDAR),
				entry('3m2aaaaaaaaa5', CALENDAR)
			]
		});

		expect(result).toEqual({ added: [], removed: [] });
		expect(writes).toEqual([]);
	});

	it.each([
		['the about space', ABOUT],
		["another group's calendar space", 'at://did:plc:other/space/net.openmeet.space.calendar/self']
	])('refuses %s as the calendar space, before any write', async (_case, calendarSpace) => {
		await expect(
			writeGroupSpaceIndex({
				db,
				env,
				group,
				callerDid: OWNER,
				writer,
				reader,
				existing: [],
				calendarSpace
			})
		).rejects.toThrow(GroupRecordError);
		expect(writes).toHaveLength(0);
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

	// The escalation this gate prevents. The permissions record is the authz
	// config: a member who could write it could bind their own role to
	// ASSIGN_ROLES and take over the group. It is configuration, so it needs
	// MANAGE_GROUP, like the profile, the rules and the access record.
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
			// A group-defined bundle, which needs no deploy because roles are
			// data. A greeter who may admit and create events holds one action
			// in each record.
			bundles: { member: ['ADMIT_MEMBERS', 'CREATE_EVENT'] }
		});

		expect(writes.map((write) => write.rkey)).toEqual(['member', 'self', 'self']);
		expect(writes[1].record.roles).toEqual([
			{ role: 'member', actions: ['admit'], assignable: [] }
		]);
		expect(writes[2].record.bindings).toEqual([{ role: 'member', actions: ['createEvent'] }]);
	});
});

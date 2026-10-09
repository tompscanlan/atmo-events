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
// the group), and that the calendar space gets its index entry only from a
// caller that names it: create does, repair does not. That a membership lands
// where the gate reads it is the roster tests' (./roster.test.ts), which run
// every act through these writers.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import {
	dropGroupMembership,
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from './members-writer';

import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION
} from '../members-record';
import {
	recordingWriter,
	spaceReader,
	type FakeSpaceReader,
	type RecordingWriter
} from './__fixtures__/space-reader';

import { spaceUri } from '../ids';
import { GroupPermissionError, GroupRecordError, type GroupRepoWrite } from './group-write';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
/** Written out, so a wrong type in the constant cannot pass by agreeing with itself. */
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: RecordingWriter;
/** Reads back what `writer` wrote, so the gate resolves from the same members
 *  space the test writes into. It starts empty (no authz config), so the gate
 *  falls back to the roster rows `addMember` seeded. */
let reader: FakeSpaceReader;

// The writers take an env only to resolve a credential, and every case here
// injects its own transport, so it is never consulted.
const env = {};

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	}));

	reader = spaceReader(GROUP_DID);
	writer = recordingWriter(reader);
	writes = writer.writes;
});

afterEach(() => harness.close());

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

	// `public: false` written into the about space of a public group would
	// contradict its read policy. That record is writeAboutAccess's alone.
	it.each([
		['the about space', ABOUT],
		["another group's calendar space", 'at://did:plc:other/space/rsvp.atmo.group.calendar/self'],
		['a space of another type', `at://${GROUP_DID}/space/com.example.other/self`]
	])('refuses to write it into %s', async (_case, space) => {
		await expect(
			writeGroupAccess({ db, env, group, callerDid: OWNER, writer, reader, space })
		).rejects.toThrow(GroupRecordError);
		expect(writes).toHaveLength(0);
	});
});

describe('writeGroupSpaceIndex', () => {
	const indexWrites = () => writes.filter((w) => w.collection === GROUP_SPACE_COLLECTION);
	const entry = (rkey: string, space: string) => ({ rkey, space });

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
		["another group's calendar space", 'at://did:plc:other/space/rsvp.atmo.group.calendar/self']
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

describe('every refusal comes before any write', () => {
	const membership = (input: Partial<Parameters<typeof putGroupMembership>[0]>) =>
		putGroupMembership({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader,
			subject: STRANGER,
			roles: ['member'],
			intent: 'admit',
			...input
		});
	const drop = (input: Partial<Parameters<typeof dropGroupMembership>[0]>) =>
		dropGroupMembership({
			db,
			env,
			group,
			callerDid: MEMBER,
			writer,
			reader,
			subject: ADMIN,
			intent: 'leave',
			...input
		});

	it.each([
		[
			'an admit by a member who holds no ADMIT_MEMBERS',
			() => membership({ callerDid: MEMBER }),
			GroupPermissionError
		],
		[
			'a role change by a member who holds no ASSIGN_ROLES',
			() => membership({ callerDid: MEMBER, subject: MEMBER, roles: ['admin'], intent: 'assign' }),
			GroupPermissionError
		],
		[
			'a membership that would grant no role at all',
			() => membership({ roles: [] }),
			GroupRecordError
		],
		[
			'a write before the members space exists',
			() => membership({ group: { ...group, members_space_uri: null } }),
			GroupRecordError
		],
		[
			'a write into a members space of another type',
			() =>
				membership({
					group: {
						...group,
						members_space_uri: `at://${group.group_did}/space/com.example.other/self`
					}
				}),
			/is not .*'s members space/
		],
		// The self-service pair is a member's own: aimed at anyone else, a join
		// would be an unguarded admit and a leave an unguarded eject.
		[
			'a join recorded for somebody else',
			() => membership({ callerDid: MEMBER, intent: 'join' }),
			GroupPermissionError
		],
		['a leave aimed at somebody else', () => drop({}), GroupPermissionError],
		[
			'an eject by a member who holds no EJECT_MEMBERS',
			() => drop({ intent: 'eject' }),
			GroupPermissionError
		],
		// Configuration takes MANAGE_GROUP. A member who could write the authz
		// config could bind their own role to ASSIGN_ROLES and take over the group.
		[
			'the access record, from a member',
			() => writeGroupAccess({ db, env, callerDid: MEMBER, group, writer, reader }),
			GroupPermissionError
		],
		[
			'the authz config, from a member',
			() => writeGroupAuthz({ db, env, callerDid: MEMBER, group, writer, reader }),
			GroupPermissionError
		]
	] as const)('refuses %s', async (_case, run, refusal) => {
		await expect(run()).rejects.toThrow(refusal);
		expect(writes).toEqual([]);
	});
});

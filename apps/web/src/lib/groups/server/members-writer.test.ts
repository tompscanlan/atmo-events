import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { authzReader } from './__fixtures__/members-space';
import { recordingWriter, type RecordingWriter } from './__fixtures__/space-reader';
import { dropGroupMembership, putGroupMembership } from './members-writer';
import { GroupPermissionError, GroupRecordError } from './group-write';
import { GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
import { MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { spaceUri } from '../ids';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CREATOR = 'did:plc:creator';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

let harness: SqliteD1;
let group: GroupRow;
let writer: RecordingWriter;
let as: Omit<Parameters<typeof putGroupMembership>[0], 'subject' | 'roles' | 'intent'>;

beforeEach(async () => {
	let db: D1Database;
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: CREATOR,
		name: 'Kona'
	}));
	const reader = authzReader(GROUP_DID, { [CREATOR]: 'admin' });
	writer = recordingWriter(reader);
	as = { db, env: {}, group, callerDid: CREATOR, writer, reader };
});

afterEach(() => harness.close());

describe('the roster records', () => {
	it('keeps one record per member, keyed by DID, with every role id it names', async () => {
		await putGroupMembership({ ...as, subject: STRANGER, roles: ['member'], intent: 'admit' });
		await putGroupMembership({ ...as, subject: STRANGER, roles: ['moderator'], intent: 'assign' });
		await dropGroupMembership({ ...as, subject: STRANGER, intent: 'eject' });

		expect(
			writer.writes.map((w) => [w.space, w.collection, w.rkey, w.intent, w.record.roles])
		).toEqual([
			[MEMBERS, GROUP_MEMBERSHIP_COLLECTION, STRANGER, 'create', ['member']],
			[MEMBERS, GROUP_MEMBERSHIP_COLLECTION, STRANGER, 'update', ['moderator']],
			[MEMBERS, GROUP_MEMBERSHIP_COLLECTION, STRANGER, 'delete', undefined]
		]);
		expect(writer.writes[0].record).toMatchObject({ member: STRANGER });
	});
});

describe('every refusal comes before any write', () => {
	const admit = (input: Partial<Parameters<typeof putGroupMembership>[0]> = {}) =>
		putGroupMembership({ ...as, subject: STRANGER, roles: ['member'], intent: 'admit', ...input });

	it.each([
		['an admit from an anonymous caller', () => admit({ callerDid: null }), GroupPermissionError],
		[
			'an eject from an anonymous caller',
			() => dropGroupMembership({ ...as, callerDid: null, subject: STRANGER, intent: 'eject' }),
			GroupPermissionError
		],
		['a membership with no role', () => admit({ roles: [] }), GroupRecordError],
		[
			'a write before the members space exists',
			() => admit({ group: { ...group, members_space_uri: null } }),
			GroupRecordError
		],
		[
			'a write into a space of another type',
			() =>
				admit({
					group: { ...group, members_space_uri: `at://${GROUP_DID}/space/com.example.other/self` }
				}),
			GroupRecordError
		]
	] as const)('refuses %s', async (_case, run, refusal) => {
		await expect(run()).rejects.toBeInstanceOf(refusal);
		expect(writer.writes).toEqual([]);
	});
});

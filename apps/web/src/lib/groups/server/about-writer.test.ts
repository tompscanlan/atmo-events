import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { authzReader } from './__fixtures__/members-space';
import { recordingWriter, type RecordingWriter } from './__fixtures__/space-reader';
import { alignAboutAccess, createGroupRules, writeGroupProfile } from './about-writer';
import { GroupPermissionError, GroupRecordError } from './group-write';
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '../about-record';
import { GROUP_ACCESS_COLLECTION, parseGroupAccess } from '../members-record';
import { spaceUri } from '../ids';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let group: GroupRow;
let writer: RecordingWriter;
let as: Parameters<typeof writeGroupProfile>[0];

beforeEach(async () => {
	let db: D1Database;
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona'
	}));
	writer = recordingWriter();
	as = {
		db,
		env: {},
		group,
		callerDid: OWNER,
		writer,
		reader: authzReader(GROUP_DID, { [OWNER]: 'admin' }),
		profile: { name: 'Kona', joinPolicy: 'approval' }
	};
});

afterEach(() => harness.close());

describe('writeGroupProfile', () => {
	it('puts the singleton into the meta space, with the group as repo', async () => {
		await writeGroupProfile({
			...as,
			profile: { name: 'Kona', description: 'Weekly rides', joinPolicy: 'open' }
		});
		expect(writer.writes).toEqual([
			expect.objectContaining({
				space: ABOUT,
				repo: GROUP_DID,
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				intent: 'update',
				record: {
					$type: GROUP_PROFILE_COLLECTION,
					displayName: 'Kona',
					description: 'Weekly rides',
					joinPolicy: 'open'
				}
			})
		]);
	});
});

describe('alignAboutAccess', () => {
	const hostGrants = [
		{ role: 'admin', scopes: ['space:group.opensocial.meta?collection=*'] },
		{ role: 'member', scopes: ['space:group.opensocial.meta?action=read'] }
	];

	it("keeps the host's grants and changes only public", async () => {
		const wrote = await alignAboutAccess(
			{ ...as, visibility: 'public' },
			parseGroupAccess({ public: false, grants: hostGrants })
		);
		expect(wrote).toBe(true);
		expect(writer.writes).toEqual([
			expect.objectContaining({
				space: ABOUT,
				collection: GROUP_ACCESS_COLLECTION,
				record: { $type: GROUP_ACCESS_COLLECTION, public: true, grants: hostGrants }
			})
		]);
	});

	it('writes nothing when the record already says the visibility', async () => {
		const current = parseGroupAccess({ public: true, grants: hostGrants });
		expect(await alignAboutAccess({ ...as, visibility: 'public' }, current)).toBe(false);
		expect(writer.writes).toEqual([]);
	});
});

describe('createGroupRules', () => {
	it('creates one record per rule, in order, and nothing for none', async () => {
		await createGroupRules({ ...as, rules: [] });
		expect(writer.writes).toEqual([]);

		await createGroupRules({
			...as,
			rules: [
				{ text: 'Be kind', order: 0 },
				{ text: 'No spam', order: 1 }
			]
		});
		expect(
			writer.writes.map((w) => [w.collection, w.intent, w.space, w.record.text, w.record.order])
		).toEqual([
			[GROUP_RULE_COLLECTION, 'create', ABOUT, 'Be kind', 0],
			[GROUP_RULE_COLLECTION, 'create', ABOUT, 'No spam', 1]
		]);
		expect(new Set(writer.writes.map((w) => w.rkey)).size).toBe(2);
	});
});

describe('every refusal comes before any write', () => {
	it.each([
		['a profile from an anonymous caller', { callerDid: null }, GroupPermissionError],
		['a group with no meta space yet', { group: { about_space_uri: null } }, GroupRecordError],
		[
			'a space of another type',
			{ group: { about_space_uri: `at://${GROUP_DID}/space/com.example.other/self` } },
			GroupRecordError
		],
		[
			'a space under another DID',
			{ group: { about_space_uri: `at://did:plc:someoneelse/space/${ABOUT_SPACE_TYPE}/self` } },
			GroupRecordError
		]
	] as const)('refuses %s', async (_case, change, refusal) => {
		const { group: groupChange, ...rest } = change as {
			group?: Partial<GroupRow>;
			callerDid?: null;
		};
		await expect(
			writeGroupProfile({ ...as, ...rest, group: { ...group, ...groupChange } })
		).rejects.toBeInstanceOf(refusal);
		expect(writer.writes).toEqual([]);
	});
});

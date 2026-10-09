// The about-space writer. The case that matters most is that editing the rules
// does not break a citation. A writer that deleted every rule record and
// re-created the list would pass every "the rules render" assertion and still
// be wrong, because a rule has to stay citable by URI. So the reconcile is
// asserted through the writes it makes, not through the list it ends up with.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import { setGroupRules, writeGroupProfile } from './about-writer';
import type { GroupRuleRecord } from './about-read';

import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '../about-record';

import { spaceUri } from '../ids';
import { GroupPermissionError, type GroupRepoWrite } from './group-write';
import { recordingWriter, type RecordingWriter } from './__fixtures__/space-reader';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: RecordingWriter;

// The writer takes an env only to find the group's linked session, and these
// cases inject their own writer, so it is never consulted.
const env = {};

/** A rule as the reader would have returned it. */
function existing(rkey: string, text: string, order: number): GroupRuleRecord {
	return {
		rkey,
		uri: `${ABOUT}/${GROUP_DID}/${GROUP_RULE_COLLECTION}/${rkey}`,
		text,
		order,
		createdAt: '2026-09-01T12:00:00.000Z'
	};
}

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	}));
	// The writers get no members space, so the gate resolves from the roster rows.
	group = { ...group, members_space_uri: null };

	writer = recordingWriter();
	writes = writer.writes;
});

afterEach(() => harness.close());

describe('writeGroupProfile', () => {
	it('writes to the about SPACE with the group as repo, not to the public repo', async () => {
		await writeGroupProfile({
			db,
			env,
			group,
			visibility: 'public',
			callerDid: ADMIN,
			writer,
			profile: { name: 'Kona', description: 'Weekly rides' }
		});
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			space: ABOUT,
			// The space scopes access; it does not reparent the record.
			repo: GROUP_DID,
			collection: GROUP_PROFILE_COLLECTION,
			rkey: 'self',
			// `self` is a singleton, so an edit must overwrite rather than fail.
			intent: 'update'
		});
	});

	// With no join policy given, the record describes the group as the save
	// has it: `joinPolicy` is derived from the visibility the caller passes and
	// the row's require_approval.
	it('derives joinPolicy from the visibility and the row rather than trusting a caller', async () => {
		await writeGroupProfile({
			db,
			env,
			group: { ...group, require_approval: 1 },
			visibility: 'private',
			callerDid: OWNER,
			writer,
			profile: { name: 'Kona' }
		});
		expect(writes[0].record).toMatchObject({ joinPolicy: 'invite' });
	});
});

describe('setGroupRules: a citation survives an edit', () => {
	it('keeps the rkey of an unchanged rule and only replaces the changed one', async () => {
		const before = [
			existing('aaa', 'Be kind', 0),
			existing('bbb', 'No spam', 1),
			existing('ccc', 'Stay on topic', 2)
		];

		const result = await setGroupRules({
			db,
			env,
			group,
			callerDid: ADMIN,
			writer,
			desired: ['Be kind', 'No self-promotion', 'Stay on topic'],
			existing: before
		});

		// The two unchanged rules keep their records untouched, so the URIs a
		// moderation action cited yesterday still resolve.
		expect(result.kept.map((rule) => rule.rkey)).toEqual(['aaa', 'ccc']);
		expect(result.kept.map((rule) => rule.uri)).toEqual([before[0].uri, before[2].uri]);

		// Exactly one create and one delete: the middle rule, and nothing else.
		expect(result.created).toHaveLength(1);
		expect(result.created[0].text).toBe('No self-promotion');
		expect(result.deleted).toEqual([{ rkey: 'bbb', text: 'No spam' }]);

		// And no write touched 'aaa' at all: position 0 did not move, so there
		// was nothing to rewrite.
		expect(writes.filter((write) => write.rkey === 'aaa')).toHaveLength(0);
	});

	// Reordering must not change URIs either: the order lives on the record, so
	// a moved rule is a put against the same rkey.
	it('rewrites a reordered rule in place, same rkey, new order', async () => {
		const before = [existing('aaa', 'Be kind', 0), existing('bbb', 'No spam', 1)];

		const result = await setGroupRules({
			db,
			env,
			group,
			callerDid: ADMIN,
			writer,
			desired: ['No spam', 'Be kind'],
			existing: before
		});

		expect(result.created).toHaveLength(0);
		expect(result.deleted).toHaveLength(0);
		expect(writes.map((write) => [write.rkey, write.intent, write.record.order])).toEqual([
			['bbb', 'update', 0],
			['aaa', 'update', 1]
		]);
	});

	it('preserves a kept rule createdAt when rewriting its order', async () => {
		await setGroupRules({
			db,
			env,
			group,
			callerDid: ADMIN,
			writer,
			desired: ['Second', 'Be kind'],
			existing: [existing('aaa', 'Be kind', 0), existing('bbb', 'Second', 1)]
		});
		const rewritten = writes.find((write) => write.rkey === 'aaa');
		expect(rewritten?.record.createdAt).toBe('2026-09-01T12:00:00.000Z');
	});

	it('deletes every rule when the list is emptied', async () => {
		const result = await setGroupRules({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			desired: [],
			existing: [existing('aaa', 'Be kind', 0)]
		});
		expect(result.deleted).toEqual([{ rkey: 'aaa', text: 'Be kind' }]);
		expect(writes).toEqual([
			expect.objectContaining({ rkey: 'aaa', intent: 'delete', space: ABOUT })
		]);
	});

	it('collapses duplicate lines into one rule', async () => {
		const result = await setGroupRules({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			desired: ['Be kind', '  Be kind  ', 'No spam'],
			existing: []
		});
		expect(result.created.map((rule) => rule.text)).toEqual(['Be kind', 'No spam']);
	});

	it('writes every rule into the about space as the group', async () => {
		await setGroupRules({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			desired: ['Be kind'],
			existing: []
		});
		expect(writes[0]).toMatchObject({
			space: ABOUT,
			repo: GROUP_DID,
			collection: GROUP_RULE_COLLECTION,
			intent: 'create'
		});
	});
});

describe('every refusal comes before any write', () => {
	const profile = (input: Partial<Parameters<typeof writeGroupProfile>[0]>) =>
		writeGroupProfile({
			db,
			env,
			group,
			visibility: 'public',
			callerDid: OWNER,
			writer,
			profile: { name: 'Kona' },
			...input
		});

	it.each([
		[
			'a profile from a member without MANAGE_GROUP',
			() => profile({ callerDid: MEMBER }),
			GroupPermissionError
		],
		[
			'a profile from an anonymous caller',
			() => profile({ callerDid: null }),
			GroupPermissionError
		],
		[
			'rules from a stranger',
			() =>
				setGroupRules({
					db,
					env,
					group,
					callerDid: STRANGER,
					writer,
					desired: ['Anything'],
					existing: []
				}),
			GroupPermissionError
		],
		// A group whose provisioning did not finish has nowhere to put a profile.
		// Saying so beats writing to a URI the PDS has never heard of.
		[
			'a profile for a group with no about space yet',
			() => profile({ group: { ...group, about_space_uri: null } }),
			/no about space/
		],
		// A row that names a space of another type, or under another DID, would
		// strand the records where no reader looks.
		[
			'a profile into a space of another type',
			() =>
				profile({
					group: {
						...group,
						about_space_uri: `at://${group.group_did}/space/com.example.other/self`
					}
				}),
			/is not .*'s about space/
		],
		[
			'a profile into a space under another DID',
			() =>
				profile({
					group: {
						...group,
						about_space_uri: `at://did:plc:someoneelse/space/${ABOUT_SPACE_TYPE}/self`
					}
				}),
			/is not .*'s about space/
		]
	] as const)('refuses %s', async (_case, run, refusal) => {
		await expect(run()).rejects.toThrow(refusal);
		expect(writes).toEqual([]);
	});
});

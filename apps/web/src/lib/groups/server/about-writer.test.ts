// The about-space writer. The case that matters most here is SC-011, and it is
// worth saying why it needs its own test: a writer that deleted every rule
// record and re-created the list from scratch would pass every "the rules
// render" assertion and still be wrong, because a rule has to stay citable by
// URI. So the reconcile is asserted through the WRITES it makes, not through the
// list it ends up with.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import { setGroupRules, writeGroupProfile } from './about-writer';
import type { GroupRuleRecord } from './about-read';
import { GroupPermissionError, type GroupRepoWrite, type GroupRepoWriter } from './event-writer';
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '../about-record';
import { spaceUri } from './spaces';

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
let writer: GroupRepoWriter;

const env = { GROUP_CREDENTIALS: undefined as string | undefined };

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
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		slug: 'kona',
		status: 'published'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: ABOUT,
		membersSpaceUri: spaceUri(GROUP_DID, 'net.openmeet.space.members', 'self')
	});
	group = { ...group, about_space_uri: ABOUT };

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return {
			uri: write.space
				? `${write.space}/${write.repo}/${write.collection}/${write.rkey}`
				: `at://${write.repo}/${write.collection}/${write.rkey}`,
			cid: 'bafytest'
		};
	};
});

afterEach(() => harness.close());

describe('writeGroupProfile', () => {
	it('writes to the about SPACE with the group as repo, not to the public repo', async () => {
		await writeGroupProfile({
			db,
			env,
			group,
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

	// The record must describe the group as the DATABASE has it, not as a form
	// claimed: `joinPolicy` is derived from visibility + require_approval.
	it('derives joinPolicy from the row rather than trusting a caller', async () => {
		await writeGroupProfile({
			db,
			env,
			group: { ...group, visibility: 'private', require_approval: 1 },
			callerDid: OWNER,
			writer,
			profile: { name: 'Kona', joinPolicy: undefined }
		});
		expect(writes[0].record).toMatchObject({ joinPolicy: 'invite' });
	});

	it('refuses a member without MANAGE_GROUP before any write is attempted', async () => {
		await expect(
			writeGroupProfile({
				db,
				env,
				group,
				callerDid: MEMBER,
				writer,
				profile: { name: 'Hijacked' }
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	it('refuses an anonymous caller before any write is attempted', async () => {
		await expect(
			writeGroupProfile({ db, env, group, callerDid: null, writer, profile: { name: 'Nope' } })
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});

	// A group whose provisioning did not finish has nowhere to put a profile.
	// Saying so beats writing to a URI the PDS has never heard of.
	it('refuses when the group has no about space yet', async () => {
		await expect(
			writeGroupProfile({
				db,
				env,
				group: { ...group, about_space_uri: null },
				callerDid: OWNER,
				writer,
				profile: { name: 'Kona' }
			})
		).rejects.toThrow(/no about space/);
		expect(writes).toHaveLength(0);
	});
});

describe('setGroupRules — SC-011, a citation survives an edit', () => {
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

		// And no write touched 'aaa' at all — position 0 did not move, so there
		// was nothing to rewrite.
		expect(writes.filter((write) => write.rkey === 'aaa')).toHaveLength(0);
	});

	// Reordering must not churn URIs either: the order lives on the record, so a
	// moved rule is a put against the SAME rkey.
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

	it('refuses a stranger before any write is attempted', async () => {
		await expect(
			setGroupRules({
				db,
				env,
				group,
				callerDid: STRANGER,
				writer,
				desired: ['Anything'],
				existing: []
			})
		).rejects.toThrow(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

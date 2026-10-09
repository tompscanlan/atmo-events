// Reading the control plane back, and the cache-repair rebuild.
//
// Two cases here matter most:
//
//   1. a space record's URI is space-scoped, so the collection and rkey have to
//      come off the tail. A reader that assumed at://<repo>/<collection>/<rkey>
//      would mis-split every record and silently return nothing;
//   2. the rebuild caches the profile as it stands. `require_approval` follows
//      the profile's join policy, `open` included, for a private group too. That
//      does not open a private group: it is invite-only because its host reads
//      it as private, and the join policy is derived from that where it is
//      shown and enforced (`groupFace`, `requestJoin`), not from the row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { createGroup, getGroupById, recordGroupSpaces } from './repo';
import { pdsSpaceReader, readGroupAbout, type GroupSpaceReader } from './about-read';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord
} from '../about-record';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';

import { splitRecordUri, spaceUri } from '../ids';
import { cacheFromProfile, rebuildGroupCache } from './rebuild';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

/** A reader over a fixed set of records, addressed the way a space addresses
 *  them: `<space>/<repo>/<collection>/<rkey>`. */
function readerOver(
	records: { collection: string; rkey: string; value: Record<string, unknown> }[]
): GroupSpaceReader {
	const all = records.map((record) => ({
		uri: `${ABOUT}/${GROUP_DID}/${record.collection}/${record.rkey}`,
		cid: 'bafytest',
		collection: record.collection,
		rkey: record.rkey,
		value: record.value
	}));
	return {
		async get(query) {
			return (
				all.find(
					(record) => record.collection === query.collection && record.rkey === query.rkey
				) ?? null
			);
		},
		async list() {
			return all;
		},
		async getSpace() {
			throw new Error('this fake holds records, not a space configuration');
		}
	};
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Stale name',
		description: 'Stale description',
		locationName: 'Stale location'
	});
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: ABOUT,
		membersSpaceUri: spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self')
	});
	group = { ...group, about_space_uri: ABOUT };
});

afterEach(() => harness.close());

describe('splitRecordUri', () => {
	// The space-scoped form. This is the one the PDS returns.
	it('takes the collection and rkey off the tail of a space-scoped URI', () => {
		expect(
			splitRecordUri(
				'at://did:plc:owner/space/group.opensocial.meta/self/did:plc:repo/group.opensocial.rule/3mvg'
			)
		).toEqual({ collection: 'group.opensocial.rule', rkey: '3mvg' });
	});

	it('handles a plain repo URI the same way', () => {
		expect(splitRecordUri('at://did:plc:repo/group.opensocial.profile/self')).toEqual({
			collection: 'group.opensocial.profile',
			rkey: 'self'
		});
	});
});

describe('readGroupAbout', () => {
	it('returns the profile and only the rule records, ignoring anything else', async () => {
		const reader = readerOver([
			{
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				value: groupProfileRecord({ name: 'Kona', joinPolicy: 'approval' })
			},
			{
				collection: GROUP_RULE_COLLECTION,
				rkey: 'bbb',
				value: groupRuleRecord({ text: 'No spam', order: 1 })
			},
			{
				collection: GROUP_RULE_COLLECTION,
				rkey: 'aaa',
				value: groupRuleRecord({ text: 'Be kind', order: 0 })
			},
			// A record class this reader does not read must not become a rule.
			{ collection: 'group.opensocial.role', rkey: 'admin', value: { name: 'admin' } }
		]);

		const about = await readGroupAbout(reader, group);
		expect(about.profile?.name).toBe('Kona');
		expect(about.rules.map((rule) => rule.text)).toEqual(['Be kind', 'No spam']);
	});

	it('sorts by the declared order extension, not by listing order', async () => {
		const reader = readerOver([
			{
				collection: GROUP_RULE_COLLECTION,
				rkey: 'ccc',
				value: groupRuleRecord({ text: 'Third', order: 2 })
			},
			{
				collection: GROUP_RULE_COLLECTION,
				rkey: 'aaa',
				value: groupRuleRecord({ text: 'First', order: 0 })
			},
			{
				collection: GROUP_RULE_COLLECTION,
				rkey: 'bbb',
				value: groupRuleRecord({ text: 'Second', order: 1 })
			}
		]);
		const about = await readGroupAbout(reader, group);
		expect(about.rules.map((rule) => rule.text)).toEqual(['First', 'Second', 'Third']);
	});

	// A group with an empty about space still has to render its page from the
	// cache. So an empty space is the absent case, not an error case, and reading
	// it must not throw.
	it('reports an empty about space as absent rather than throwing', async () => {
		expect(await readGroupAbout(readerOver([]), group)).toEqual({ profile: null, rules: [] });
	});

	it('reports a group with no about space as absent without calling the reader', async () => {
		let called = false;
		const reader: GroupSpaceReader = {
			async get() {
				called = true;
				return null;
			},
			async list() {
				called = true;
				return [];
			},
			async getSpace() {
				called = true;
				return { readPolicy: 'com.atproto.simplespace.defs#publicPolicy' };
			}
		};
		const about = await readGroupAbout(reader, { ...group, about_space_uri: null });
		expect(about).toEqual({ profile: null, rules: [] });
		expect(called).toBe(false);
	});
});

describe('rebuildGroupCache: cache repair', () => {
	it('overwrites every column the profile owns', async () => {
		const reader = readerOver([
			{
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				value: groupProfileRecord({
					name: 'Kona Riders',
					description: 'Weekly rides',
					joinPolicy: 'open',
					locationName: 'Kailua-Kona'
				})
			}
		]);

		const result = await rebuildGroupCache(db, reader, group);
		expect(result).toEqual({ outcome: 'repaired', rules: 0 });

		const repaired = await getGroupById(db, group.id);
		expect(repaired).toMatchObject({
			name: 'Kona Riders',
			description: 'Weekly rides',
			location_name: 'Kailua-Kona',
			require_approval: 0
		});
	});

	// The column no record owns must survive a rebuild untouched.
	it('leaves owner_did alone', async () => {
		const reader = readerOver([
			{
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				value: groupProfileRecord({ name: 'Kona', joinPolicy: 'approval' })
			}
		]);

		await rebuildGroupCache(db, reader, group);
		const repaired = await getGroupById(db, group.id);
		expect(repaired).toMatchObject({ owner_did: OWNER });
		expect(repaired).not.toHaveProperty('visibility');
	});

	// An empty about space is not "the group has no name": wiping the cache to
	// match an absent record would destroy the only copy.
	it('leaves the cache alone when there is no profile record', async () => {
		const result = await rebuildGroupCache(db, readerOver([]), group);
		expect(result.outcome).toBe('no-profile');
		expect(await getGroupById(db, group.id)).toMatchObject({ name: 'Stale name' });
	});
});

// The two space read methods do not return the same record shape:
//
//   getRecord   -> { uri, cid, value }               a URI, no fields
//   listRecords -> { collection, rkey, cid, value }   fields, no uri
//
// A parser that required `uri` would drop every listed record and report a
// group with three rules as a group with none, silently, with a 200 on the
// wire. These cases pin both shapes.
describe('pdsSpaceReader: the live wire shapes', () => {
	const cred = linkedCredential(GROUP_DID);
	const SPACE = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
	let requested: string[];

	beforeEach(() => {
		requested = [];
		linkedCredential(GROUP_DID);
		vi.stubGlobal('fetch', async (input: URL | string) => {
			const url = String(input);
			requested.push(url);
			if (url.includes('com.atproto.space.listRecords')) {
				// The live shape: no `uri` anywhere in it.
				return Response.json({
					records: [
						{
							collection: GROUP_RULE_COLLECTION,
							rkey: 'probe1',
							cid: 'bafyrule',
							value: groupRuleRecord({ text: 'Be kind', order: 0 })
						}
					]
				});
			}
			return Response.json({
				uri: `${SPACE}/${GROUP_DID}/${GROUP_PROFILE_COLLECTION}/self`,
				cid: 'bafyprofile',
				value: groupProfileRecord({ name: 'Kona', joinPolicy: 'open' })
			});
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		unlinkAllGroups();
	});

	it('reads a listed record that carries no uri, and rebuilds the citable one', async () => {
		const reader = pdsSpaceReader(cred, GROUP_DID);
		const records = await reader.list({ space: SPACE, repo: GROUP_DID });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			collection: GROUP_RULE_COLLECTION,
			rkey: 'probe1',
			// Rebuilt in the form getRecord returns, so a rule stays citable.
			uri: `${SPACE}/${GROUP_DID}/${GROUP_RULE_COLLECTION}/probe1`
		});
	});

	it('reads a fetched record that carries a uri and no fields', async () => {
		const reader = pdsSpaceReader(cred, GROUP_DID);
		const record = await reader.get({
			space: SPACE,
			repo: GROUP_DID,
			collection: GROUP_PROFILE_COLLECTION,
			rkey: 'self'
		});
		expect(record).toMatchObject({ collection: GROUP_PROFILE_COLLECTION, rkey: 'self' });
	});

	// RecordNotFound is getRecord's answer for a key with no record, so it is the
	// one 400 that reads as absent. Every other 400 is a read that failed, and
	// the gate depends on it throwing: a refused read that came back as "no
	// records" would send the gate to the rows.
	it('reads a 400 RecordNotFound as absent', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ error: 'RecordNotFound' }, { status: 400 }));
		const reader = pdsSpaceReader(cred, GROUP_DID);
		const query = { space: SPACE, repo: GROUP_DID, collection: GROUP_PROFILE_COLLECTION };
		expect(await reader.get({ ...query, rkey: 'self' })).toBeNull();
	});

	it.each(['SpaceNotFound', 'RepoTakendown', 'InvalidRequest', undefined])(
		'throws on any other 400 (%s), for get and list alike',
		async (error) => {
			vi.stubGlobal('fetch', async () => Response.json(error ? { error } : {}, { status: 400 }));
			const reader = pdsSpaceReader(cred, GROUP_DID);
			const query = { space: SPACE, repo: GROUP_DID, collection: GROUP_PROFILE_COLLECTION };
			await expect(reader.get({ ...query, rkey: 'self' })).rejects.toThrow(/getRecord failed: 400/);
			await expect(reader.list(query)).rejects.toThrow(/listRecords failed: 400/);
		}
	);

	// The host returns one page and a cursor. A listing that stopped there would
	// read a group with more rules or members than one page as a smaller group.
	it('follows the cursor to the last page of a listing', async () => {
		const pages: (string | null)[] = [];
		vi.stubGlobal('fetch', async (input: URL | string) => {
			const url = new URL(String(input));
			const cursor = url.searchParams.get('cursor');
			pages.push(cursor);
			const rkey = cursor ? 'second' : 'first';
			return Response.json({
				cursor: cursor ? undefined : 'page-two',
				records: [
					{
						collection: GROUP_RULE_COLLECTION,
						rkey,
						cid: 'bafyrule',
						value: groupRuleRecord({ text: rkey, order: 0 })
					}
				]
			});
		});
		const reader = pdsSpaceReader(cred, GROUP_DID);
		const records = await reader.list({
			space: SPACE,
			repo: GROUP_DID,
			collection: GROUP_RULE_COLLECTION
		});
		expect(pages).toEqual([null, 'page-two']);
		expect(records.map((r) => r.rkey)).toEqual(['first', 'second']);
	});

	// The parameter names are the PDS's, and `space` and `repo` are both
	// required: listRecords returns 400 without `repo`.
	it('sends space, repo and collection as query parameters', async () => {
		const reader = pdsSpaceReader(cred, GROUP_DID);
		await reader.list({ space: SPACE, repo: GROUP_DID, collection: GROUP_RULE_COLLECTION });
		const url = new URL(requested[0]);
		expect(url.searchParams.get('space')).toBe(SPACE);
		expect(url.searchParams.get('repo')).toBe(GROUP_DID);
		expect(url.searchParams.get('collection')).toBe(GROUP_RULE_COLLECTION);
	});
});

describe('cacheFromProfile', () => {
	it('maps only the columns the profile record owns', () => {
		expect(
			cacheFromProfile({
				name: 'Kona',
				description: null,
				joinPolicy: 'invite',
				locationName: null,
				createdAt: '2026-09-01T12:00:00.000Z'
			})
		).toEqual({ name: 'Kona', description: null, require_approval: 1, location_name: null });
	});
});

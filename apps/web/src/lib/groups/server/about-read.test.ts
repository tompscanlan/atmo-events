// Reading the control plane back.
//
// The case that matters most: a space record's URI is space-scoped, so the
// collection and rkey have to come off the tail, and a listed record carries no
// URI at all. A reader that assumed at://<repo>/<collection>/<rkey>, or that
// required a `uri`, would mis-read every record and silently return nothing.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import { pdsSpaceReader, readGroupAbout } from './about-read';
import {
	spaceReader,
	type SpaceReaderOptions,
	type SpaceRecordInput
} from './__fixtures__/space-reader';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord
} from '../about-record';
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';

import { spaceUri } from '../ids';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let group: GroupRow;

/** A reader over records in the group's about space. */
const readerOver = (records: SpaceRecordInput[], options: SpaceReaderOptions = {}) =>
	spaceReader(GROUP_DID, { space: ABOUT, records, ...options });

beforeEach(async () => {
	({ harness, group } = await seedGroup({ groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' }));
});

afterEach(() => harness.close());

describe('readGroupAbout', () => {
	// From a host that ignores the collection filter, so the listing hands back
	// records that are not rules.
	it('returns the profile and only the rule records, ignoring anything else', async () => {
		const reader = readerOver(
			[
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
			],
			{ ignoresFilter: true }
		);

		const about = await readGroupAbout(reader, group);
		expect(about.profile?.name).toBe('Kona');
		expect(about.rules.map((rule) => rule.text)).toEqual(['Be kind', 'No spam']);
	});

	// A group with an empty about space still has to render its page from the
	// cache. So an empty space is the absent case, not an error case, and reading
	// it must not throw.
	it('reports an empty about space as absent rather than throwing', async () => {
		expect(await readGroupAbout(readerOver([]), group)).toEqual({ profile: null, rules: [] });
	});

	it('reports a group with no about space as absent without calling the reader', async () => {
		const reader = readerOver([]);
		const about = await readGroupAbout(reader, { ...group, about_space_uri: null });
		expect(about).toEqual({ profile: null, rules: [] });
		expect(reader.calls).toEqual([]);
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

	it.each(['SpaceNotFound', undefined])(
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

	/** One listed rule, in the live shape. */
	const listed = (rkey: string) => ({
		collection: GROUP_RULE_COLLECTION,
		rkey,
		cid: 'bafyrule',
		value: groupRuleRecord({ text: rkey, order: 0 })
	});
	const listRules = () =>
		pdsSpaceReader(cred, GROUP_DID).list({
			space: SPACE,
			repo: GROUP_DID,
			collection: GROUP_RULE_COLLECTION
		});

	// A partial listing must throw, never come back as the whole: repair unlists
	// every member a listing leaves out. So a later page with no records is a
	// listing that broke partway, not the end of one.
	it('throws when a later page comes back with no records', async () => {
		vi.stubGlobal('fetch', async (input: URL | string) =>
			new URL(String(input)).searchParams.get('cursor')
				? Response.json({})
				: Response.json({ cursor: 'page-two', records: [listed('first')] })
		);
		await expect(listRules()).rejects.toThrow('no records page');
	});

	// A host that hands back the cursor it was given would loop the listing
	// forever. This one repeats it once and then ends, so a reader that kept
	// following it returns duplicates here rather than hanging the case.
	it('stops on a cursor that does not move instead of looping', async () => {
		let pages = 0;
		vi.stubGlobal('fetch', async () => {
			pages++;
			return Response.json({
				cursor: pages < 3 ? 'page-two' : undefined,
				records: [listed(`rule${pages}`)]
			});
		});
		await expect(listRules()).rejects.toThrow('repeated its cursor');
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

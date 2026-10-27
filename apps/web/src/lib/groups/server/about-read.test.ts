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

const readerOver = (records: SpaceRecordInput[], options: SpaceReaderOptions = {}) =>
	spaceReader(GROUP_DID, { space: ABOUT, records, ...options });

beforeEach(async () => {
	({ harness, group } = await seedGroup({ groupDid: GROUP_DID, creatorDid: OWNER, name: 'Kona' }));
});

afterEach(() => harness.close());

describe('readGroupAbout', () => {
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
				{ collection: 'group.opensocial.role', rkey: 'admin', value: { name: 'admin' } }
			],
			{ ignoresFilter: true }
		);

		const about = await readGroupAbout(reader, group);
		expect(about.profile?.name).toBe('Kona');
		expect(about.rules.map((rule) => rule.text)).toEqual(['Be kind', 'No spam']);
	});

	it('reports an empty meta space, or none, as absent, reading nothing for none', async () => {
		expect(await readGroupAbout(readerOver([]), group)).toEqual({ profile: null, rules: [] });
		const reader = readerOver([]);
		const about = await readGroupAbout(reader, { ...group, about_space_uri: null });
		expect(about).toEqual({ profile: null, rules: [] });
		expect(reader.calls).toEqual([]);
	});
});

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

	it('reads a listed record with no uri and a fetched one with no fields', async () => {
		const reader = pdsSpaceReader(cred, GROUP_DID);
		const query = { space: SPACE, repo: GROUP_DID, collection: GROUP_RULE_COLLECTION };
		expect(await reader.list(query)).toEqual([
			expect.objectContaining({
				collection: GROUP_RULE_COLLECTION,
				rkey: 'probe1',
				uri: `${SPACE}/${GROUP_DID}/${GROUP_RULE_COLLECTION}/probe1`
			})
		]);
		const url = new URL(requested[0]);
		expect(Object.fromEntries(url.searchParams)).toMatchObject(query);

		const record = await reader.get({
			...query,
			collection: GROUP_PROFILE_COLLECTION,
			rkey: 'self'
		});
		expect(record).toMatchObject({ collection: GROUP_PROFILE_COLLECTION, rkey: 'self' });
	});

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
			await expect(reader.get({ ...query, rkey: 'self' })).rejects.toThrow();
			await expect(reader.list(query)).rejects.toThrow();
		}
	);

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

	it('throws when a later page comes back with no records', async () => {
		vi.stubGlobal('fetch', async (input: URL | string) =>
			new URL(String(input)).searchParams.get('cursor')
				? Response.json({})
				: Response.json({ cursor: 'page-two', records: [listed('first')] })
		);
		await expect(listRules()).rejects.toThrow();
	});

	it('stops on a cursor that does not move instead of looping', async () => {
		let pages = 0;
		vi.stubGlobal('fetch', async () => {
			pages++;
			return Response.json({
				cursor: pages < 3 ? 'page-two' : undefined,
				records: [listed(`rule${pages}`)]
			});
		});
		await expect(listRules()).rejects.toThrow();
	});
});

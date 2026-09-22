// Reading the control plane back, and the cache-repair rebuild.
//
// The two cases here that are not plumbing:
//
//   1. a space record's URI is SPACE-SCOPED, so the collection and rkey have to
//      come off the tail. A reader that assumed at://<repo>/<collection>/<rkey>
//      would mis-split every record and silently return nothing;
//   2. the rebuild must not be able to widen a private group. The profile is
//      the source of truth for `require_approval`, so a profile claiming `open`
//      on a private group is exactly the shape that would open it — and the
//      schema, not TypeScript, is what has to refuse.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { createGroup, getGroupById, recordGroupSpaces, updateGroup } from './repo';
import {
	cacheFromProfile,
	pdsSpaceReader,
	readGroupAbout,
	rebuildGroupCache,
	splitRecordUri,
	type GroupSpaceReader
} from './about-read';
import { clearGroupSessions } from './session';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord
} from '../about-record';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { spaceUri } from './spaces';

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
	// The space-scoped form — this is the one the PDS actually returns.
	it('takes the collection and rkey off the tail of a space-scoped URI', () => {
		expect(
			splitRecordUri(
				'at://did:plc:owner/space/net.openmeet.space.about/self/did:plc:repo/net.openmeet.group.rule/3mvg'
			)
		).toEqual({ collection: 'net.openmeet.group.rule', rkey: '3mvg' });
	});

	it('handles a plain repo URI the same way', () => {
		expect(splitRecordUri('at://did:plc:repo/net.openmeet.group.profile/self')).toEqual({
			collection: 'net.openmeet.group.profile',
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
			// A record class this iteration does not read must not become a rule.
			{ collection: 'net.openmeet.group.role', rkey: 'admin', value: { name: 'admin' } }
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

	// A group provisioned before this writer existed has an EMPTY about space,
	// and its page still has to render from the cache. So an empty space is the
	// absent case, not an error case — reading it must not throw. (Spec: FR-010.)
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
			}
		};
		const about = await readGroupAbout(reader, { ...group, about_space_uri: null });
		expect(about).toEqual({ profile: null, rules: [] });
		expect(called).toBe(false);
	});
});

describe('rebuildGroupCache — mode 1, cache repair', () => {
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

	// The columns no record owns must survive a rebuild untouched. `visibility` is
	// the one that matters: an `approval` join policy is what a PUBLIC
	// approval-gated group's profile carries too, so a rebuild that inverted the
	// policy back into a visibility would publish this private group. (FR-004b.)
	it('leaves visibility and owner_did alone', async () => {
		await updateGroup(db, group.id, { visibility: 'private' });
		const reader = readerOver([
			{
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				value: groupProfileRecord({ name: 'Kona', joinPolicy: 'approval' })
			}
		]);

		await rebuildGroupCache(db, reader, group);
		const repaired = await getGroupById(db, group.id);
		expect(repaired).toMatchObject({ visibility: 'private', owner_did: OWNER });
	});

	// THE SAFETY CASE. migrations/0003 forbids private + open join, so a profile
	// claiming `open` for a private group must be REFUSED rather than applied —
	// otherwise a record edit is a way to open a private group's front door.
	it('refuses to open a private group from a profile record', async () => {
		await updateGroup(db, group.id, { visibility: 'private', requireApproval: true });
		const reader = readerOver([
			{
				collection: GROUP_PROFILE_COLLECTION,
				rkey: 'self',
				value: groupProfileRecord({ name: 'Kona', joinPolicy: 'open' })
			}
		]);

		await expect(rebuildGroupCache(db, reader, group)).rejects.toThrow();
		const untouched = await getGroupById(db, group.id);
		expect(untouched).toMatchObject({ visibility: 'private', require_approval: 1 });
	});

	// An empty about space is not "the group has no name": wiping the cache to
	// match an absent record would destroy the only copy.
	it('leaves the cache alone when there is no profile record', async () => {
		const result = await rebuildGroupCache(db, readerOver([]), group);
		expect(result.outcome).toBe('no-profile');
		expect(await getGroupById(db, group.id)).toMatchObject({ name: 'Stale name' });
	});
});

// THE REGRESSION. Found by the live e2e on 2026-09-18, not by any unit test:
// the two space read methods do not return the same record shape.
//
//   getRecord   -> { uri, cid, value }               a URI, no fields
//   listRecords -> { collection, rkey, cid, value }   fields, NO uri
//
// The first parser required `uri`, so it dropped every listed record and
// reported a group with three rules as a group with none — silently, with a
// 200 on the wire. These cases pin both shapes.
describe('pdsSpaceReader — the live wire shapes', () => {
	const cred = { service: 'https://pds.stub.test', identifier: 'g.stub.test', password: 'p' };
	const SPACE = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
	let requested: string[];

	beforeEach(() => {
		requested = [];
		clearGroupSessions();
		vi.stubGlobal('fetch', async (input: URL | string) => {
			const url = String(input);
			if (url.includes('com.atproto.server.createSession')) {
				return Response.json({
					did: GROUP_DID,
					handle: 'g.stub.test',
					accessJwt: 'jwt',
					refreshJwt: 'refresh'
				});
			}
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

	afterEach(() => vi.unstubAllGlobals());

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

	// The parameter names are the live PDS's, and `space`/`repo` are both
	// required — listRecords 400s without `repo` (measured).
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
	it('maps only the Tier-1 columns from data-model.md', () => {
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

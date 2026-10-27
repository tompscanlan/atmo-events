import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

const index = vi.hoisted(() => ({ told: [] as string[] }));

vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		}
	})
}));

import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import {
	fakeGroupHost,
	type FakeGroupHost,
	type FakeGroupHostOptions
} from './server/__fixtures__/group-host';
import {
	STUB_PDS_SERVICE,
	atGroupHost,
	linkGroups,
	linkedCredential,
	unlinkAllGroups
} from './server/__fixtures__/linked-group';
import { writeAuthzRecords } from './server/__fixtures__/members-space';
import { GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY } from './about-record';
import { GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY } from './members-record';
import { pdsSpaceReader } from './server/about-read';
import { writeAboutAccess } from './server/about-writer';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/db/groups';
import { writeGroupDeclaration } from './server/declaration-writer';
import { pdsWriter } from './server/group-write';
import { putGroupMembership } from './server/members-writer';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';
import { runUpdateGroup, type UpdateGroupData } from './update-group';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:settingsgroupaaaaaaaaaaa';
const CRED = linkedCredential(GROUP_DID);
const ABOUT = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
const DECLARATION = `at://${GROUP_DID}/group.opensocial.declaration/self`;

let harness: SqliteD1;
let env: ReturnType<typeof linkGroups>;

beforeEach(() => {
	harness = sqliteD1();
	env = atGroupHost(linkGroups([GROUP_DID]));
	index.told = [];
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

function asGroup(group: GroupRow) {
	return {
		db: harness.db,
		env,
		group,
		callerDid: GROUP_DID,
		reader: pdsSpaceReader(CRED, GROUP_DID)
	};
}

/** A group as the host makes it, with the owner as admin, declared when public. */
async function givenGroup(visibility: GroupVisibility, pds: FakeGroupHost): Promise<GroupRow> {
	const row = await createGroup(harness.db, {
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona Trail Runners'
	});
	const uris = pds.holdGroup(visibility);
	await recordGroupSpaces(harness.db, row.id, uris);
	const group = {
		...row,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	await writeAuthzRecords(asGroup(group));
	await putGroupMembership({
		...asGroup(group),
		subject: OWNER,
		roles: ['admin'],
		intent: 'admit'
	});
	if (visibility === 'public') await writeGroupDeclaration(asGroup(group));
	pds.clearLog();
	index.told = [];
	return group;
}

function save(group: GroupRow, data: Partial<UpdateGroupData> & { visibility: GroupVisibility }) {
	return runUpdateGroup(
		env,
		harness.db,
		group,
		{ did: OWNER, reader: pdsSpaceReader(CRED, GROUP_DID) },
		{
			name: 'Kona Night Runners',
			shownVisibility: data.visibility,
			joinPolicy: 'approval',
			listed: true,
			...data
		}
	);
}

function traced(pds: FakeGroupHost): string[] {
	return pds.writes().map((w) => `${w.nsid.replace('com.atproto.', '')} ${w.body?.collection}`);
}

const rowName = async () => (await getGroupByDid(harness.db, GROUP_DID))?.name;

async function declaredNow(): Promise<boolean> {
	const q = new URLSearchParams({
		repo: GROUP_DID,
		collection: 'group.opensocial.declaration',
		rkey: 'self'
	});
	return (await fetch(`${STUB_PDS_SERVICE}/xrpc/com.atproto.repo.getRecord?${q}`)).ok;
}

async function aboutRecord(collection: string, rkey: string) {
	const found = await pdsSpaceReader(CRED, GROUP_DID).get({
		space: ABOUT,
		repo: GROUP_DID,
		collection,
		rkey
	});
	return found?.value ?? null;
}

/** Each host write and each read of the meta access, with the row's name at that moment. */
function rowAtEachCall() {
	const sequence: string[] = [];
	const observe: FakeGroupHostOptions['fail'] = (nsid, init, query) => {
		const accessRead =
			nsid === 'com.atproto.space.getRecord' &&
			query?.get('space') === ABOUT &&
			query?.get('collection') === GROUP_ACCESS_COLLECTION;
		const write =
			init?.method?.toUpperCase() === 'POST' && /^com\.atproto\.(space|repo)\./.test(nsid);
		if (write || accessRead) {
			const { name } = harness.raw
				.prepare('SELECT name FROM groups WHERE group_did = ?')
				.get(GROUP_DID) as { name: string };
			sequence.push(
				`${accessRead ? 'read access' : nsid.replace('com.atproto.', '')} (row ${name})`
			);
		}
		return undefined;
	};
	return { sequence, observe };
}

/** Fails each write to `collection` while `on.down`. */
const failing =
	(collection: string, on = { down: true }): FakeGroupHostOptions['fail'] =>
	(nsid, init) =>
		on.down &&
		/putRecord|deleteRecord/.test(nsid) &&
		typeof init?.body === 'string' &&
		JSON.parse(init.body).collection === collection
			? Response.json({ error: 'InternalServerError' }, { status: 500 })
			: undefined;

describe('the write order', () => {
	it('a switch to private withdraws the declaration, writes access, then the row and the profile', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = fakeGroupHost({ did: GROUP_DID, fail: observe });
		const group = await givenGroup('public', pds);
		sequence.length = 0;

		expect(await save(group, { visibility: 'private', shownVisibility: 'public' })).toEqual({
			ok: true
		});
		expect(sequence).toEqual([
			'read access (row Kona Trail Runners)',
			'repo.deleteRecord (row Kona Trail Runners)',
			'space.putRecord (row Kona Trail Runners)',
			'space.putRecord (row Kona Night Runners)'
		]);
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.access',
			'space.putRecord group.opensocial.profile'
		]);
		expect(index.told).toEqual([DECLARATION]);
		expect(await declaredNow()).toBe(false);
	});

	it('a switch to public writes access and the row, reads access again, then declares', async () => {
		const { sequence, observe } = rowAtEachCall();
		const pds = fakeGroupHost({ did: GROUP_DID, fail: observe });
		const group = await givenGroup('private', pds);
		sequence.length = 0;

		expect(await save(group, { visibility: 'public', shownVisibility: 'private' })).toEqual({
			ok: true
		});
		expect(sequence).toEqual([
			'read access (row Kona Trail Runners)',
			'space.putRecord (row Kona Trail Runners)',
			'read access (row Kona Night Runners)',
			'repo.putRecord (row Kona Night Runners)',
			'space.putRecord (row Kona Night Runners)'
		]);
		expect(await declaredNow()).toBe(true);
	});

	it('a public group saved unlisted is withdrawn and stays public', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);

		expect(await save(group, { visibility: 'public', listed: false })).toEqual({ ok: true });
		expect(traced(pds)).toEqual([
			'repo.deleteRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile'
		]);
		expect(await declaredNow()).toBe(false);
		expect((await aboutRecord(GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY))?.public).toBe(true);
	});

	it('a group another client narrows during a switch to public is not declared', async () => {
		let armed = false;
		const pds = fakeGroupHost({
			did: GROUP_DID,
			fail: (nsid, _init, query) => {
				const accessRead =
					nsid === 'com.atproto.space.getRecord' &&
					query?.get('space') === ABOUT &&
					query?.get('collection') === GROUP_ACCESS_COLLECTION;
				if (!armed || !accessRead || pds.writes().length === 0) return undefined;
				return Response.json({
					uri: `${ABOUT}/${GROUP_DID}/${GROUP_ACCESS_COLLECTION}/self`,
					cid: 'bafycreate',
					value: { public: false, grants: [] }
				});
			}
		});
		const group = await givenGroup('private', pds);
		armed = true;

		expect(await save(group, { visibility: 'public', shownVisibility: 'private' })).toEqual({
			ok: true
		});
		expect(traced(pds)).not.toContain('repo.putRecord group.opensocial.declaration');
		expect(await declaredNow()).toBe(false);
	});
});

describe('what a save keeps', () => {
	it('keeps the profile fields the form does not edit', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);
		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: GROUP_PROFILE_COLLECTION,
			rkey: GROUP_PROFILE_RKEY,
			record: {
				$type: GROUP_PROFILE_COLLECTION,
				displayName: 'Kona Trail Runners',
				joinPolicy: 'open',
				url: 'https://runners.example',
				banner: { $type: 'blob', ref: { $link: 'bafybanner' }, mimeType: 'image/png', size: 10 }
			},
			intent: 'update',
			space: ABOUT
		});

		await save(group, { visibility: 'public', joinPolicy: 'invite' });

		expect(await aboutRecord(GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY)).toMatchObject({
			displayName: 'Kona Night Runners',
			joinPolicy: 'invite',
			url: 'https://runners.example',
			banner: { ref: { $link: 'bafybanner' } }
		});
	});

	it('an untouched visibility writes no access record', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);

		await save(group, { visibility: 'public' });

		expect(traced(pds)).toEqual([
			'repo.putRecord group.opensocial.declaration',
			'space.putRecord group.opensocial.profile'
		]);
	});

	it('a stale form keeps the visibility the record has since taken', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);
		await writeAboutAccess({ ...asGroup(group), visibility: 'private' });
		pds.clearLog();

		expect(await save(group, { visibility: 'public', shownVisibility: 'public' })).toEqual({
			ok: true
		});
		expect(traced(pds)).not.toContain('space.putRecord group.opensocial.access');
		expect((await aboutRecord(GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY))?.public).toBe(false);
	});
});

describe('a save that stops', () => {
	it('is refused before any read or write when the form showed no visibility and the choice differs', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('private', pds);

		const result = await save(group, { visibility: 'public', shownVisibility: undefined });

		expect(result.ok).toBe(false);
		expect(pds.writes()).toEqual([]);
		expect(await rowName()).toBe('Kona Trail Runners');
	});

	it('reads and writes nothing for an owner whose sign-in reads no spaces', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);

		const result = await runUpdateGroup(
			env,
			harness.db,
			group,
			{ did: OWNER, reader: null },
			{
				name: 'Kona Night Runners',
				visibility: 'public',
				shownVisibility: 'public',
				joinPolicy: 'approval',
				listed: true
			}
		);

		expect(result.ok).toBe(false);
		expect(pds.requests).toEqual([]);
	});

	it('leaves the row as it was when its first write fails', async () => {
		const on = { down: false };
		const pds = fakeGroupHost({ did: GROUP_DID, fail: failing(GROUP_ACCESS_COLLECTION, on) });
		const group = await givenGroup('private', pds);
		on.down = true;

		const result = await save(group, { visibility: 'public', shownVisibility: 'private' });

		expect(result.ok).toBe(false);
		expect(await rowName()).toBe('Kona Trail Runners');
		expect(await declaredNow()).toBe(false);
	});

	it('is finished by saving again after a later write fails', async () => {
		const on = { down: false };
		const pds = fakeGroupHost({ did: GROUP_DID, fail: failing(GROUP_PROFILE_COLLECTION, on) });
		const group = await givenGroup('private', pds);
		on.down = true;

		const first = await save(group, { visibility: 'public', shownVisibility: 'private' });
		expect(first.ok).toBe(false);
		expect(await rowName()).toBe('Kona Night Runners');

		on.down = false;
		expect(await save(group, { visibility: 'public', shownVisibility: 'public' })).toEqual({
			ok: true
		});
		expect((await aboutRecord(GROUP_PROFILE_COLLECTION, GROUP_PROFILE_RKEY))?.displayName).toBe(
			'Kona Night Runners'
		);
		expect(await declaredNow()).toBe(true);
	});

	it('writes nothing for a group not at this site’s group host', async () => {
		const pds = fakeGroupHost({ did: GROUP_DID });
		const group = await givenGroup('public', pds);

		const result = await runUpdateGroup(
			linkGroups([GROUP_DID]),
			harness.db,
			group,
			{ did: OWNER, reader: pdsSpaceReader(CRED, GROUP_DID) },
			{
				name: 'Renamed',
				visibility: 'private',
				shownVisibility: 'public',
				joinPolicy: 'open',
				listed: true
			}
		);

		expect(result.ok).toBe(false);
		expect(pds.writes()).toEqual([]);
		expect(await rowName()).toBe('Kona Trail Runners');
	});
});

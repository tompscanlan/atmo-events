import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

const index = vi.hoisted(() => ({ told: [] as string[], down: null as Error | null }));

vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			if (index.down) throw index.down;
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		}
	})
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	LINKED_TEST_TOKEN,
	atGroupHost,
	linkGroups,
	unlinkAllGroups
} from './__fixtures__/linked-group';
import {
	fakeGroupHost,
	type FakeGroupHost,
	type FakeGroupHostOptions
} from './__fixtures__/group-host';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	uploadGroupEventImage,
	writeGroupEvent,
	type UploadGroupEventImageInput,
	type WriteGroupEventInput
} from './event-writer';
import type { GroupRow } from '../types';

import { GROUP_EVENT_COLLECTION } from '../ids';
import { GroupPermissionError, GroupRecordError } from './group-write';
import { GroupNotAtHostError } from './host';
import { GroupCredentialError } from './session';
import { createGroup } from './db/groups';
import { addMember } from './db/roster';
import { authzReader } from './__fixtures__/members-space';
import type { FakeSpaceReader } from './__fixtures__/space-reader';
import { spaceUri } from '../ids';
import { MEMBERS_SPACE_TYPE } from '../types';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let pds: FakeGroupHost;
let linkedEnv: ReturnType<typeof linkGroups>;
let authz: FakeSpaceReader;

function validRecord(name = 'Kona weekly ride') {
	return {
		name,
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	};
}

async function onHost(options: Partial<FakeGroupHostOptions> = {}) {
	pds = fakeGroupHost({ did: GROUP_DID, ...options });
	linkedEnv = atGroupHost(linkGroups([GROUP_DID]));
	pds.holdGroup('public');
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');
	group = { ...group, members_space_uri: spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self') };
	authz = authzReader(GROUP_DID, { [OWNER]: 'admin', [ADMIN]: 'admin', [MEMBER]: 'member' });

	index.told = [];
	index.down = null;
	vi.spyOn(console, 'info').mockImplementation(() => {});
	await onHost();
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

const write = (input: Partial<WriteGroupEventInput> & Pick<WriteGroupEventInput, 'intent'>) =>
	writeGroupEvent({
		db,
		env: linkedEnv,
		group,
		callerDid: ADMIN,
		record: validRecord(),
		reader: authz,
		...input
	});

const remove = (rkey: string, input: Partial<Parameters<typeof deleteGroupEvent>[0]> = {}) =>
	deleteGroupEvent({
		db,
		env: linkedEnv,
		group,
		callerDid: ADMIN,
		rkey,
		reader: authz,
		...input
	});


async function hostRecord(rkey: string) {
	const [requests, calls] = [pds.requests.length, pds.calls.length];
	const query = new URLSearchParams({ repo: GROUP_DID, collection: GROUP_EVENT_COLLECTION, rkey });
	const res = await fetch(`https://pds.stub.test/xrpc/com.atproto.repo.getRecord?${query}`);
	pds.requests.splice(requests);
	pds.calls.splice(calls);
	return res.ok ? ((await res.json()) as { value: Record<string, unknown> }).value : null;
}

const hostHas = async (rkey: string) => (await hostRecord(rkey)) !== null;

describe('authorship', () => {
	it('lets a non-owner admin edit an event the owner created, as the group', async () => {
		const created = await write({ callerDid: OWNER, intent: 'create' });
		expect(created.repo).toBe(GROUP_DID);

		const edited = await write({
			intent: 'update',
			rkey: created.rkey,
			record: {
				...validRecord('Weekly ride, new time'),
				startsAt: '2026-09-21T18:00:00.000Z'
			}
		});

		expect(edited.rkey).toBe(created.rkey);
		expect(edited.repo).toBe(GROUP_DID);
		expect(edited.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);

		expect(pds.writes().map((w) => [w.nsid, w.body?.repo])).toEqual([
			['com.atproto.repo.createRecord', GROUP_DID],
			['com.atproto.repo.putRecord', GROUP_DID]
		]);
		expect(await hostRecord(created.rkey)).toMatchObject({ name: 'Weekly ride, new time' });
	});

	it('mints a TID for a create, and refuses an update that names no rkey', async () => {
		const created = await write({ intent: 'create' });
		expect(created.rkey).toMatch(/^[a-z2-7]{13}$/);
		expect(pds.writes().map((w) => [w.nsid, w.body?.rkey])).toEqual([
			['com.atproto.repo.createRecord', created.rkey]
		]);

		await expect(write({ intent: 'update' })).rejects.toBeInstanceOf(GroupRecordError);
		expect(pds.writes()).toHaveLength(1);
	});

	it('refuses a result whose URI is not in the group repo', async () => {
		await onHost({
			fail: (nsid) =>
				nsid === 'com.atproto.repo.createRecord'
					? Response.json({ uri: `at://${ADMIN}/${GROUP_EVENT_COLLECTION}/abc`, cid: 'x' })
					: undefined
		});

		await expect(write({ intent: 'create' })).rejects.toBeInstanceOf(GroupRecordError);
		expect(index.told).toEqual([]);
	});
});

describe('the permission gate', () => {
	it('deletes from the group repo, on the admin’s own session', async () => {
		const created = await write({ intent: 'create' });
		pds.clearLog();

		const deleted = await remove(created.rkey);
		expect(deleted.repo).toBe(GROUP_DID);
		expect(pds.writes()).toEqual([
			{
				nsid: 'com.atproto.repo.deleteRecord',
				body: { repo: GROUP_DID, collection: GROUP_EVENT_COLLECTION, rkey: created.rkey },
				params: {},
				token: LINKED_TEST_TOKEN,
				person: ADMIN
			}
		]);
		expect(await hostHas(created.rkey)).toBe(false);
	});

	it('an anonymous caller is refused before any PDS read or write', async () => {
		const refused = [
			() => write({ callerDid: null, intent: 'create' }),
			() => write({ callerDid: null, intent: 'update', rkey: '3abc' }),
			() => remove('3abc', { callerDid: null })
		];
		for (const run of refused) await expect(run()).rejects.toBeInstanceOf(GroupPermissionError);
		expect(pds.calls).toEqual([]);
		expect(index.told).toEqual([]);

		await write({ intent: 'update', rkey: '3abc' });
		expect(pds.calls).not.toEqual([]);
	});

	it('refuses a group not at this site’s group host before any request', async () => {
		const elsewhere = linkGroups([GROUP_DID]);
		const refused = [
			() => write({ env: elsewhere, intent: 'create' }),
			() => write({ env: elsewhere, intent: 'update', rkey: '3abc' }),
			() => remove('3abc', { env: elsewhere })
		];
		for (const run of refused) await expect(run()).rejects.toBeInstanceOf(GroupNotAtHostError);
		expect(pds.calls).toEqual([]);
		expect(index.told).toEqual([]);
	});
});

describe('record validation', () => {
	it('rejects a malformed record before anything reaches the transport', async () => {
		await expect(
			write({
				intent: 'create',
				record: { createdAt: '2026-09-01T12:00:00.000Z' }
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(pds.calls).toEqual([]);
	});

	it('stamps the collection $type rather than trusting the caller', async () => {
		const created = await write({
			intent: 'create',
			record: { ...validRecord(), $type: 'app.bsky.feed.post' }
		});
		expect(pds.writes().map((w) => w.body?.collection)).toEqual([GROUP_EVENT_COLLECTION]);
		expect(await hostRecord(created.rkey)).toMatchObject({ $type: GROUP_EVENT_COLLECTION });
	});
});

describe('records from the event editor', () => {
	it('accepts the record the event editor builds, image and theme included', async () => {
		const editorRecord = {
			$type: GROUP_EVENT_COLLECTION,
			createdWith: 'https://atmo.rsvp',
			name: 'Kona weekly ride',
			mode: 'community.lexicon.calendar.event#inperson',
			status: 'community.lexicon.calendar.event#scheduled',
			startsAt: '2026-10-04T17:00:00.000Z',
			endsAt: '2026-10-04T19:00:00.000Z',
			timezone: 'Pacific/Honolulu',
			createdAt: '2026-09-30T12:00:00.000Z',
			theme: { name: 'default', accentColor: 'cyan', baseColor: 'stone' },
			description: 'Meet at the pier.',
			uris: [{ uri: 'https://example.com/route', name: 'Route' }],
			locations: [{ $type: 'community.lexicon.location.address', country: 'US', locality: 'Kona' }],
			media: [
				{
					role: 'thumbnail',
					content: {
						$type: 'blob',
						ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
						mimeType: 'image/webp',
						size: 12345
					},
					aspect_ratio: { width: 1200, height: 630 }
				}
			],
			preferences: { showInDiscovery: true }
		};

		const result = await write({
			intent: 'create',
			rkey: '3mwqnkcuf7cnp',
			record: editorRecord
		});

		expect(result.repo).toBe(GROUP_DID);
		expect(await hostRecord('3mwqnkcuf7cnp')).toEqual(editorRecord);
	});
});

describe('credentials', () => {
	it('checks for a caller before the credential', async () => {
		await expect(
			writeGroupEvent({
				db,
				env: {},
				group: { ...group, members_space_uri: null },
				callerDid: null,
				intent: 'create',
				record: validRecord()
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
	});

	describe('for a group nobody has linked', () => {
		beforeEach(() => unlinkAllGroups());

		const unlinked = () => atGroupHost(linkGroups(['did:plc:anothergroupaaaaaaaaaaaa']));

		it('refuses an admin’s event through the real writer, and sends nothing', async () => {
			await expect(write({ env: unlinked(), intent: 'create' })).rejects.toBeInstanceOf(
				GroupCredentialError
			);
			expect(pds.calls).toEqual([]);
			expect(index.told).toEqual([]);
		});
	});
});

describe('telling the index', () => {
	it('reports success when the index is unreachable', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		index.down = new Error('D1_ERROR: Network connection lost');

		const result = await write({ callerDid: OWNER, intent: 'create' });

		expect(result.repo).toBe(GROUP_DID);
		expect(await hostHas(result.rkey)).toBe(true);
		expect(logged).toHaveBeenCalledOnce();
	});
});

describe('event images', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

	const upload = (input: Partial<UploadGroupEventImageInput> = {}) =>
		uploadGroupEventImage({
			db,
			env: linkedEnv,
			group,
			callerDid: ADMIN,
			intent: 'create',
			bytes: PNG,
			reader: authz,
			mimeType: 'image/png',
			...input
		});

	it("uploads an admin's image into the group's repo, as the write it is for", async () => {
		const ref = await upload();

		expect(pds.blobs).toEqual([{ mimeType: 'image/png', bytes: PNG }]);
		expect(ref).toEqual({
			$type: 'blob',
			ref: { $link: 'bafkreiupload1' },
			mimeType: 'image/png',
			size: 4
		});
	});

	it('refuses an anonymous upload before the transport', async () => {
		for (const intent of ['create', 'update'] as const) {
			await expect(upload({ callerDid: null, intent })).rejects.toBeInstanceOf(
				GroupPermissionError
			);
		}
		expect(pds.calls).toEqual([]);
	});

	it('refuses a file that is not an image, or is too large, before the transport', async () => {
		await expect(upload({ mimeType: 'text/html' })).rejects.toBeInstanceOf(GroupRecordError);
		await expect(
			upload({ bytes: new Uint8Array(GROUP_EVENT_IMAGE_MAX_BYTES + 1) })
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(pds.calls).toEqual([]);
	});
});

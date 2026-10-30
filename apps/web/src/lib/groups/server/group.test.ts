import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	resolve: vi.fn(),
	crowdedServers: vi.fn()
}));
vi.mock('./declared', () => ({ crowdedServers: mocks.crowdedServers }));
vi.mock('#lib/contrail/index.js', () => ({
	getServerClient: () => ({ get: mocks.get, post: mocks.post })
}));
vi.mock('#lib/atproto/network.js', () => ({ atprotoNetwork: () => undefined }));
vi.mock('@svelte-atproto/oauth/network', () => ({
	createActorResolver: () => ({ resolve: mocks.resolve })
}));

import {
	atGroupHost,
	heldAtGroupHost,
	isDeclared,
	listCrowdedServers,
	listDeclaredGroups,
	listGroup,
	parseGroupProfile,
	readCards,
	readGroupMeta,
	resolveGroup,
	storeCard,
	unlistGroup
} from './group';

const GROUP = 'did:plc:group';
let kv: MemoryKV;
const hostFetch = vi.fn<typeof fetch>();

/** The group host's listRepos: one page per entry, each a list of [did, active]. */
function hostHolds(...pages: [string, boolean][][]) {
	hostFetch.mockImplementation(async (input) => {
		const cursor = new URL(String(input)).searchParams.get('cursor');
		const index = cursor ? Number(cursor) : 0;
		const repos = (pages[index] ?? []).map(([did, active]) => ({ did, active }));
		return Response.json({
			repos,
			...(index + 1 < pages.length ? { cursor: `${index + 1}` } : {})
		});
	});
}

/** A PDS that answers `getRecord` from `records`, keyed by collection. */
function pds(records: Record<string, unknown>): ReturnType<typeof vi.fn<XrpcHandle>> {
	return vi.fn<XrpcHandle>(async (pathname, init) => {
		if (init.method === 'POST') return Response.json({ uri: 'at://x', cid: 'c' });
		const collection = new URL(pathname, 'http://x').searchParams.get('collection') ?? '';
		if (collection in records) return Response.json({ value: records[collection] });
		return Response.json({ error: 'RecordNotFound' }, { status: 400 });
	});
}

beforeEach(() => {
	vi.resetAllMocks();
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv, GROUP_HOST_URL: 'https://host.example/' });
	mocks.post.mockResolvedValue({ ok: true, data: {} });
	vi.stubGlobal('fetch', hostFetch);
	hostHolds([[GROUP, true]]);
});

describe('resolveGroup', () => {
	it('drops a handle that fails the two-way check', async () => {
		mocks.resolve.mockResolvedValue({ did: GROUP, handle: 'handle.invalid', pds: 'https://p' });
		expect(await resolveGroup(GROUP)).toEqual({ did: GROUP, handle: null, pds: 'https://p' });
	});

	it('reads an unresolvable actor as no group', async () => {
		mocks.resolve.mockRejectedValue(new Error('no such handle'));
		expect(await resolveGroup('nobody.example')).toBeNull();
	});
});

describe('atGroupHost', () => {
	it('is true only for a PDS at the configured host', () => {
		expect(atGroupHost({ pds: 'https://host.example' })).toBe(true);
		expect(atGroupHost({ pds: 'https://elsewhere.example' })).toBe(false);
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		expect(atGroupHost({ pds: 'https://host.example' })).toBe(false);
	});
});

describe('the declaration index', () => {
	it('answers from the index alone, so a hidden declaration is not declared', async () => {
		mocks.get.mockResolvedValueOnce({ ok: true, status: 200, data: {} });
		expect(await isDeclared(GROUP)).toBe(true);
		mocks.get.mockResolvedValueOnce({ ok: false, status: 404, data: { error: 'NotFound' } });
		expect(await isDeclared(GROUP)).toBe(false);
		expect(mocks.get).toHaveBeenLastCalledWith('rsvp.atmo.declaration.getRecord', {
			params: { uri: `at://${GROUP}/group.opensocial.declaration/self` }
		});
	});

	it('throws when the index cannot say', async () => {
		mocks.get.mockResolvedValueOnce({ ok: false, status: 500, data: { error: 'Internal' } });
		await expect(isDeclared(GROUP)).rejects.toThrow();
	});

	it("lists declared groups in the index's order, newest first, with no profiles", async () => {
		mocks.get.mockResolvedValue({
			ok: true,
			data: {
				records: [
					{ did: 'did:plc:newer', time_us: 3_000_000 },
					{ did: GROUP, time_us: 2_000_000 }
				],
				cursor: 'next'
			}
		});
		expect(await listDeclaredGroups()).toEqual({
			groups: [
				{ did: 'did:plc:newer', indexedAt: 3000 },
				{ did: GROUP, indexedAt: 2000 }
			],
			cursor: 'next'
		});
		const [nsid, { params }] = mocks.get.mock.calls[0];
		// One per account, at most 20 per server, but all the groups this site's group host holds.
		expect(nsid).toBe('rsvp.atmo.declaration.listDeclared');
		expect(params).toEqual({ limit: 100, home: 'https://host.example', held: `["${GROUP}"]` });
	});

	it('asks for the page after a cursor, and says when there is none after it', async () => {
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		expect(await listDeclaredGroups({ cursor: 'page2' })).toEqual({ groups: [], cursor: null });
		expect(mocks.get.mock.calls[0][1].params).toEqual({
			limit: 100,
			cursor: 'page2',
			home: 'https://host.example',
			held: `["${GROUP}"]`
		});
	});

	it("lists one server's groups for its own page", async () => {
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		await listDeclaredGroups({ server: 'https://pds.example' });
		expect(mocks.get.mock.calls[0][1].params).toEqual({
			limit: 100,
			server: 'https://pds.example'
		});
		expect(hostFetch).not.toHaveBeenCalled();
	});

	it("lists only what the group host holds on the host's own page", async () => {
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		await listDeclaredGroups({ server: 'https://host.example' });
		expect(mocks.get.mock.calls[0][1].params).toEqual({
			limit: 100,
			server: 'https://host.example',
			home: 'https://host.example',
			held: `["${GROUP}"]`
		});
	});

	it('limits the group host like any server when it does not say what it holds', async () => {
		hostFetch.mockResolvedValue(new Response('down', { status: 502 }));
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		await listDeclaredGroups();
		expect(mocks.get.mock.calls[0][1].params).toEqual({ limit: 100 });
		mocks.crowdedServers.mockResolvedValue([]);
		await listCrowdedServers();
		expect(mocks.crowdedServers.mock.calls[0][1]).toBeNull();
	});

	it("names the crowded servers, with this site's group host left out", async () => {
		mocks.crowdedServers.mockResolvedValue([{ server: 'https://pds.example', more: 3 }]);
		expect(await listCrowdedServers()).toEqual([{ server: 'https://pds.example', more: 3 }]);
		expect(mocks.crowdedServers.mock.calls[0][1]).toBe('https://host.example');
	});
});

describe('parseGroupProfile', () => {
	it('needs a display name, and trims', () => {
		expect(parseGroupProfile({ displayName: '  Knitters ', description: ' ' })).toEqual({
			name: 'Knitters',
			description: null,
			joinPolicy: 'invite'
		});
		expect(parseGroupProfile({ displayName: 'K', joinPolicy: 'open' })?.joinPolicy).toBe('open');
		expect(parseGroupProfile({ description: 'no name' })).toBeNull();
		expect(parseGroupProfile(null)).toBeNull();
	});
});

describe('readGroupMeta', () => {
	it('reads the profile and access out of the meta space', async () => {
		const handle = pds({
			'group.opensocial.profile': { displayName: 'Knitters' },
			'group.opensocial.access': { public: true }
		});
		expect(await readGroupMeta(handle, GROUP)).toEqual({
			profile: { name: 'Knitters', description: null, joinPolicy: 'invite' },
			public: true
		});
		expect(handle.mock.calls[0][0]).toContain(
			`space=${encodeURIComponent(`at://${GROUP}/space/group.opensocial.meta/self`)}`
		);
	});

	it('reads a missing access record as private', async () => {
		const handle = pds({ 'group.opensocial.profile': { displayName: 'Knitters' } });
		expect((await readGroupMeta(handle, GROUP)).public).toBe(false);
	});

	it('throws on anything but a record or RecordNotFound', async () => {
		const handle = vi.fn<XrpcHandle>(async () => new Response('{}', { status: 502 }));
		await expect(readGroupMeta(handle, GROUP)).rejects.toThrow();
	});
});

describe('listing', () => {
	it('writes the declaration naming the meta space, then tells the index', async () => {
		const handle = pds({});
		await listGroup(handle, GROUP);
		const [pathname, init] = handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.putRecord');
		expect(JSON.parse(String(init.body))).toEqual({
			repo: GROUP,
			collection: 'group.opensocial.declaration',
			rkey: 'self',
			record: {
				$type: 'group.opensocial.declaration',
				meta: `at://${GROUP}/space/group.opensocial.meta/self`
			}
		});
		expect(mocks.post).toHaveBeenCalledWith('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [`at://${GROUP}/group.opensocial.declaration/self`] }
		});
	});

	it('deletes the declaration to unlist, then tells the index', async () => {
		const handle = pds({});
		await unlistGroup(handle, GROUP);
		const [pathname, init] = handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.deleteRecord');
		expect(JSON.parse(String(init.body))).toEqual({
			repo: GROUP,
			collection: 'group.opensocial.declaration',
			rkey: 'self'
		});
		expect(mocks.post).toHaveBeenCalledWith('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [`at://${GROUP}/group.opensocial.declaration/self`] }
		});
	});
});

describe('cards', () => {
	const group = { did: GROUP, handle: 'knit.example' };

	it("keeps a public group's name for visitors", async () => {
		await storeCard(group, { profile: { name: 'Knitters', description: 'Yarn' }, public: true });
		expect((await readCards([GROUP, 'did:plc:none'])).get(GROUP)).toEqual({
			name: 'Knitters',
			description: 'Yarn',
			handle: 'knit.example'
		});
	});

	it("removes a group's card once it is private", async () => {
		await storeCard(group, { profile: { name: 'Knitters', description: null }, public: true });
		await storeCard(group, { profile: { name: 'Knitters', description: null }, public: false });
		expect(kv.keys()).toEqual([]);
	});
});

describe('heldAtGroupHost', () => {
	it("reads every page of the host's listRepos, leaves out inactive accounts, and caches it", async () => {
		hostHolds(
			[
				[GROUP, true],
				['did:plc:gone', false]
			],
			[['did:plc:second', true]]
		);
		expect(await heldAtGroupHost()).toEqual([GROUP, 'did:plc:second']);
		expect(String(hostFetch.mock.calls[0][0])).toBe(
			'https://host.example/xrpc/com.atproto.sync.listRepos?limit=1000'
		);
		expect(hostFetch).toHaveBeenCalledTimes(2);
		expect(await heldAtGroupHost()).toEqual([GROUP, 'did:plc:second']);
		expect(hostFetch).toHaveBeenCalledTimes(2);
	});

	it('is null with no group host, or when the host does not answer', async () => {
		hostFetch.mockRejectedValue(new Error('offline'));
		expect(await heldAtGroupHost()).toBeNull();
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		expect(await heldAtGroupHost()).toBeNull();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { fakeKemHost } from '#lib/spaces/server/__fixtures__/space-mac-host.js';
import { SpaceAccessDenied, type SpaceHosts } from '#lib/spaces/server/space-credential.js';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import { isAuthRefused, isRoleRefused, XrpcError, type XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	post: vi.fn(),
	resolve: vi.fn(),
	crowdedServers: vi.fn(),
	cachedHandles: vi.fn(),
	ensureInit: vi.fn(),
	/** Calls to other servers: the group host's space methods. */
	networkFetch: vi.fn<typeof fetch>()
}));
vi.mock('./declared', () => ({
	crowdedServers: mocks.crowdedServers,
	cachedHandles: mocks.cachedHandles
}));
vi.mock('#lib/contrail/index.js', () => ({
	ensureInit: mocks.ensureInit,
	getServerClient: () => ({ get: mocks.get, post: mocks.post })
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('@svelte-atproto/oauth/network', () => ({
	createActorResolver: () => ({ resolve: mocks.resolve })
}));

import {
	atGroupHost,
	declaredHome,
	forgetHeldAtGroupHost,
	groupHostSpaces,
	heldAtGroupHost,
	isDeclared,
	listCrowdedServers,
	listDeclaredGroups,
	listGroup,
	parseGroupProfile,
	readCachedHandles,
	readCachedProfiles,
	readGroupMeta,
	resolveGroup,
	storeCachedProfile,
	syncDeclarationIndex,
	unlistGroup
} from './group';

const GROUP = 'did:plc:group';
const HOST = 'https://host.example';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
const kem = await fakeKemHost();
const spaceHosts: SpaceHosts = { repoHost: async () => HOST, kemKey: async () => kem.did };
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

describe("a link's reads of the group's spaces", () => {
	it('go to the configured group host, whatever the DID document names now', async () => {
		expect(await groupHostSpaces.repoHost(GROUP)).toBe('https://host.example');
		expect(mocks.resolve).not.toHaveBeenCalled();
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(groupHostSpaces.repoHost(GROUP)).rejects.toThrow();
	});
});

describe('atGroupHost', () => {
	it('is true only for a PDS at the configured host', () => {
		expect(atGroupHost({ pds: 'https://host.example' })).toBe(true);
		expect(atGroupHost({ pds: 'https://elsewhere.example' })).toBe(false);
		expect(atGroupHost({ pds: 'not a url' })).toBe(false);
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
			params: { uri: `at://${GROUP}/org.atgrp.declaration/self` }
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
		// One per account, at most 20 per server; the index asks what the group host holds itself.
		expect(nsid).toBe('rsvp.atmo.declaration.listDeclared');
		expect(params).toEqual({ limit: 100 });
	});

	it('names the group host to the index, with what it holds, read only when asked', async () => {
		const home = declaredHome();
		expect(home?.origin).toBe('https://host.example');
		expect(hostFetch).not.toHaveBeenCalled();
		expect(await home?.held()).toEqual([GROUP]);
		hostFetch.mockResolvedValue(new Response('down', { status: 502 }));
		await forgetHeldAtGroupHost();
		expect(await home?.held()).toBeNull();
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		expect(declaredHome()).toBeNull();
	});

	it('asks for the page after a cursor, and says when there is none after it', async () => {
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		expect(await listDeclaredGroups({ cursor: 'page2' })).toEqual({ groups: [], cursor: null });
		expect(mocks.get.mock.calls[0][1].params).toEqual({ limit: 100, cursor: 'page2' });
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

	it('leaves the group host out of the crowded servers only when it says what it holds', async () => {
		hostFetch.mockResolvedValue(new Response('down', { status: 502 }));
		mocks.crowdedServers.mockResolvedValue([]);
		await listCrowdedServers();
		expect(mocks.crowdedServers.mock.calls[0][1]).toBeNull();
	});

	it("reads the index's tables only once contrail has made them, as on a fresh database", async () => {
		// contrail makes its tables, the declarations' among them, when the Worker first uses it.
		let made = false;
		let make: () => void = () => {};
		mocks.ensureInit.mockReturnValue(
			new Promise<void>((resolve) => (make = resolve)).then(() => {
				made = true;
			})
		);
		const table = () =>
			made ? Promise.resolve([]) : Promise.reject(new Error('no such table: records_declaration'));
		mocks.crowdedServers.mockImplementation(table);
		mocks.cachedHandles.mockImplementation(() =>
			made ? Promise.resolve(new Map()) : Promise.reject(new Error('no such table: identities'))
		);
		const crowded = listCrowdedServers();
		const handles = readCachedHandles([GROUP]);
		await vi.waitFor(() => expect(mocks.ensureInit).toHaveBeenCalledTimes(2));
		expect(mocks.crowdedServers).not.toHaveBeenCalled();
		expect(mocks.cachedHandles).not.toHaveBeenCalled();
		make();
		expect(await crowded).toEqual([]);
		expect(await handles).toEqual(new Map());
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
			description: null
		});
		expect(parseGroupProfile({ description: 'no name' })).toBeNull();
		expect(parseGroupProfile(null)).toBeNull();
	});
});

describe('readGroupMeta', () => {
	const about = { displayName: 'Knitters' };
	const policy = (publicRead?: boolean) => ({
		policy: {
			$type: 'org.atgrp.policy',
			grants: [],
			...(publicRead === undefined ? {} : { publicRead })
		}
	});

	/** The group host as a meta read meets it: a delegation token to the group's session, a
	 *  credential for it from authorizeSpaceSync, and each record in the meta space with its MAC.
	 *  `refuse` answers a step instead. */
	function groupHost(
		records: Record<string, unknown>,
		refuse: {
			delegate?: () => Response;
			exchange?: () => Response;
			read?: (url: URL) => Response;
		} = {}
	) {
		const exchanges: Record<string, unknown>[] = [];
		const reads: { url: URL; headers: Headers }[] = [];
		const handle = vi.fn<XrpcHandle>(
			async () => refuse.delegate?.() ?? Response.json({ token: 'delegation' })
		);
		mocks.networkFetch.mockImplementation(async (input, init) => {
			const url = new URL(String(input));
			const headers = new Headers(init?.headers);
			if (url.pathname === '/xrpc/com.atproto.space.authorizeSpaceSync') {
				exchanges.push(JSON.parse(String(init?.body)));
				return refuse.exchange?.() ?? Response.json({ credential: 'credential' });
			}
			if (url.pathname === '/xrpc/com.atproto.space.getRecord') {
				reads.push({ url, headers });
				if (refuse.read) return refuse.read(url);
				const q = url.searchParams;
				const collection = q.get('collection')!;
				if (!(collection in records)) {
					return Response.json({ error: 'RecordNotFound' }, { status: 400 });
				}
				const value = records[collection];
				const uri = `${q.get('space')}/${q.get('repo')}/${collection}/${q.get('rkey')}`;
				const answered = await kem.recordAnswer(headers, { uri, cid: 'bafy', value });
				return Response.json({ uri, cid: answered.cid, value }, { headers: answered.headers });
			}
			return Response.json({ error: 'MethodNotImplemented' }, { status: 501 });
		});
		return { handle, exchanges, reads };
	}

	it("reads the about record and the policy with a credential the group's session bought", async () => {
		const host = groupHost({
			'org.atgrp.about': about,
			'com.atproto.space.policy': policy(true)
		});
		expect(await readGroupMeta(host.handle, GROUP, spaceHosts)).toEqual({
			profile: { name: 'Knitters', description: null },
			public: true
		});

		// The session asks only for the delegation token, once for both records.
		expect(host.handle.mock.calls).toEqual([
			[
				`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space: META })}`,
				{ method: 'GET' }
			]
		]);
		expect(host.exchanges).toEqual([
			{
				space: META,
				credentialKey: expect.stringMatching(/^did:key:zDn/),
				delegationToken: 'delegation'
			}
		]);
		// Each read is signed for the group's repo with the credential, and asks for the MAC.
		expect(host.reads.map((r) => r.url.searchParams.get('collection')).sort()).toEqual([
			'com.atproto.space.policy',
			'org.atgrp.about'
		]);
		for (const { url, headers } of host.reads) {
			expect(url.origin).toBe(HOST);
			expect(Object.fromEntries(url.searchParams)).toMatchObject({
				space: META,
				repo: GROUP,
				rkey: 'self'
			});
			expect(headers.get('authorization')).toBe('Atproto-Space-Credential credential');
			expect(headers.get('atproto-space-audience')).toBe(GROUP);
			expect(headers.get('accept-signature')).toContain('tag="atproto-space-record"');
		}
	});

	it('reads a missing policy, or one without publicRead, as private', async () => {
		const missing = groupHost({ 'org.atgrp.about': about });
		expect((await readGroupMeta(missing.handle, GROUP, spaceHosts)).public).toBe(false);
		const unset = groupHost({ 'org.atgrp.about': about, 'com.atproto.space.policy': policy() });
		expect((await readGroupMeta(unset.handle, GROUP, spaceHosts)).public).toBe(false);
	});

	it('never takes a record whose MAC does not verify', async () => {
		// The record asked for, but with no MAC.
		const host = groupHost(
			{},
			{
				read: (url) =>
					Response.json({
						uri: `${META}/${GROUP}/${url.searchParams.get('collection')}/self`,
						cid: 'bafy',
						value: about
					})
			}
		);
		await expect(readGroupMeta(host.handle, GROUP, spaceHosts)).rejects.toThrow('MAC of at:space/');
	});

	it.each([
		['the session holds no scope that reads it', 'delegate', 403, 'ScopeMissing'],
		['its member no longer reads it', 'delegate', 403, 'NotAuthorized'],
		['the host no longer lets the grant read it', 'exchange', 400, 'SpaceNotFound']
	] as const)('is a refusal, not an outage, when %s', async (_why, step, status, error) => {
		const host = groupHost({}, { [step]: () => Response.json({ error }, { status }) });
		const thrown = await readGroupMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(SpaceAccessDenied);
		expect(isRoleRefused(thrown)).toBe(true);
		expect(isAuthRefused(thrown)).toBe(false);
		expect(host.reads).toEqual([]);
	});

	it('asks to link again when the host refuses the session itself', async () => {
		const host = groupHost(
			{},
			{ delegate: () => Response.json({ error: 'invalid_token' }, { status: 401 }) }
		);
		const thrown = await readGroupMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toMatchObject({ nsid: 'com.atproto.space.getDelegationToken', status: 401 });
		expect(isAuthRefused(thrown)).toBe(true);
		expect(isRoleRefused(thrown)).toBe(false);
	});

	it('reads a credential the host refuses at the read as roles that no longer allow it', async () => {
		const host = groupHost(
			{},
			{ read: () => Response.json({ error: 'CredentialRevoked' }, { status: 401 }) }
		);
		const thrown = await readGroupMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(XrpcError);
		expect(isRoleRefused(thrown)).toBe(true);
		expect(isAuthRefused(thrown)).toBe(false);
	});

	it('throws on anything but a record or RecordNotFound', async () => {
		const host = groupHost({}, { read: () => new Response('{}', { status: 502 }) });
		const thrown = await readGroupMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(XrpcError);
		expect(isRoleRefused(thrown)).toBe(false);
		expect(isAuthRefused(thrown)).toBe(false);
	});
});

describe('the index of a declaration the group host keeps itself', () => {
	const DECLARATION = `at://${GROUP}/org.atgrp.declaration/self`;
	const indexHas = (declared: boolean) =>
		mocks.get.mockResolvedValueOnce(
			declared
				? { ok: true, status: 200, data: {} }
				: { ok: false, status: 404, data: { error: 'NotFound' } }
		);

	it.each([
		['the repo has one the index lacks', true, false],
		['the index has one the repo no longer does', false, true]
	])('is told to read it again when %s', async (_when, inRepo, indexed) => {
		indexHas(indexed);
		await syncDeclarationIndex(GROUP, inRepo);
		expect(mocks.post).toHaveBeenCalledWith('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [DECLARATION] }
		});
	});

	it.each([true, false])('is left alone when it agrees with the repo (%s)', async (inRepo) => {
		indexHas(inRepo);
		await syncDeclarationIndex(GROUP, inRepo);
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it('never fails the page when the index cannot say', async () => {
		mocks.get.mockResolvedValueOnce({ ok: false, status: 500, data: { error: 'Internal' } });
		await expect(syncDeclarationIndex(GROUP, true)).resolves.toBeUndefined();
		expect(mocks.post).not.toHaveBeenCalled();
	});
});

describe('listing', () => {
	it('writes the empty declaration, then tells the index', async () => {
		const handle = pds({});
		await listGroup(handle, GROUP);
		const [pathname, init] = handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.putRecord');
		expect(JSON.parse(String(init.body))).toEqual({
			repo: GROUP,
			collection: 'org.atgrp.declaration',
			rkey: 'self',
			record: { $type: 'org.atgrp.declaration' }
		});
		expect(mocks.post).toHaveBeenCalledWith('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [`at://${GROUP}/org.atgrp.declaration/self`] }
		});
	});

	it('forgets what the group host was last said to hold, so the group is counted at once', async () => {
		hostHolds([['did:plc:other', true]]);
		expect(await heldAtGroupHost()).toEqual(['did:plc:other']);
		await listGroup(pds({}), GROUP);
		hostHolds([
			['did:plc:other', true],
			[GROUP, true]
		]);
		expect(await heldAtGroupHost()).toEqual(['did:plc:other', GROUP]);
	});

	it('deletes the declaration to unlist, then tells the index', async () => {
		const handle = pds({});
		await unlistGroup(handle, GROUP);
		const [pathname, init] = handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.deleteRecord');
		expect(JSON.parse(String(init.body))).toEqual({
			repo: GROUP,
			collection: 'org.atgrp.declaration',
			rkey: 'self'
		});
		expect(mocks.post).toHaveBeenCalledWith('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [`at://${GROUP}/org.atgrp.declaration/self`] }
		});
	});
});

describe('cached group profiles', () => {
	const group = { did: GROUP, handle: 'knit.example' };

	it("keeps a public group's name for visitors", async () => {
		await storeCachedProfile(group, {
			profile: { name: 'Knitters', description: 'Yarn' },
			public: true
		});
		expect((await readCachedProfiles([GROUP, 'did:plc:none'])).get(GROUP)).toEqual({
			name: 'Knitters',
			description: 'Yarn',
			handle: 'knit.example'
		});
		expect(kv.keys()).toEqual([`group:profile:${GROUP}`]);
	});

	it("removes a group's cached profile once it is private", async () => {
		await storeCachedProfile(group, {
			profile: { name: 'Knitters', description: null },
			public: true
		});
		await storeCachedProfile(group, {
			profile: { name: 'Knitters', description: null },
			public: false
		});
		expect(kv.keys()).toEqual([]);
	});

	it('writes or removes it only when it changes', async () => {
		const put = vi.spyOn(kv, 'put');
		const remove = vi.spyOn(kv, 'delete');
		const knitters = { profile: { name: 'Knitters', description: 'Yarn' }, public: true };
		await storeCachedProfile(group, knitters);
		await storeCachedProfile(group, knitters);
		await storeCachedProfile(group, { ...knitters, profile: { ...knitters.profile } });
		expect(put).toHaveBeenCalledOnce();

		await storeCachedProfile(group, {
			...knitters,
			profile: { ...knitters.profile, name: 'Purl' }
		});
		await storeCachedProfile(
			{ ...group, handle: 'purl.example' },
			{
				...knitters,
				profile: { ...knitters.profile, name: 'Purl' }
			}
		);
		expect(put).toHaveBeenCalledTimes(3);

		await storeCachedProfile(group, { ...knitters, public: false });
		await storeCachedProfile(group, { ...knitters, public: false });
		await storeCachedProfile(group, { profile: null, public: true });
		expect(remove).toHaveBeenCalledOnce();
		expect(kv.keys()).toEqual([]);
	});

	it('writes it when the cached one could not be read', async () => {
		vi.spyOn(kv, 'get').mockRejectedValue(new Error('KV down'));
		const put = vi.spyOn(kv, 'put');
		await storeCachedProfile(group, {
			profile: { name: 'Knitters', description: null },
			public: true
		});
		expect(put).toHaveBeenCalledOnce();
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

	it('gives up on a host that never answers, so the list treats it like any server', async () => {
		const limit = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
		try {
			hostFetch.mockImplementation(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						const signal = init?.signal;
						if (signal?.aborted) reject(signal.reason);
						signal?.addEventListener('abort', () => reject(signal.reason));
					})
			);
			const held = heldAtGroupHost();
			limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
			expect(await held).toBeNull();
			expect(kv.ttlOf('groups:held-at-host')).toBe(60);
		} finally {
			timeout.mockRestore();
		}
	});

	it('remembers for a minute that the host did not answer, so the next page does not wait again', async () => {
		hostFetch.mockRejectedValueOnce(new Error('offline'));
		expect(await heldAtGroupHost()).toBeNull();
		expect(kv.ttlOf('groups:held-at-host')).toBe(60);
		hostHolds([[GROUP, true]]);
		expect(await heldAtGroupHost()).toBeNull();
		expect(hostFetch).toHaveBeenCalledTimes(1);
	});

	it('asks the host once for two lists that want it at the same time', async () => {
		expect(await Promise.all([heldAtGroupHost(), heldAtGroupHost()])).toEqual([[GROUP], [GROUP]]);
		expect(hostFetch).toHaveBeenCalledTimes(1);
	});

	it('keeps the cached answer otherwise, and caches no read that began before it was forgotten', async () => {
		let answer: (res: Response) => void = () => {};
		hostFetch.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
		const before = heldAtGroupHost();
		await vi.waitFor(() => expect(hostFetch).toHaveBeenCalled());
		await forgetHeldAtGroupHost();
		answer(Response.json({ repos: [{ did: 'did:plc:other', active: true }] }));
		expect(await before).toEqual(['did:plc:other']);
		expect(kv.keys()).toEqual([]);
		hostHolds([[GROUP, true]]);
		expect(await heldAtGroupHost()).toEqual([GROUP]);
		hostHolds([['did:plc:later', true]]);
		expect(await heldAtGroupHost()).toEqual([GROUP]);
	});

	it('is null with no group host, or when the host does not answer', async () => {
		hostFetch.mockRejectedValue(new Error('offline'));
		expect(await heldAtGroupHost()).toBeNull();
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		expect(await heldAtGroupHost()).toBeNull();
	});
});

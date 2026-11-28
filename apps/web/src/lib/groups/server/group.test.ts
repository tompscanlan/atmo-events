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
	upcomingGroups: vi.fn(),
	groupServers: vi.fn(),
	groupLabels: vi.fn(),
	cacheProfile: vi.fn(),
	ensureInit: vi.fn(),
	ensureGroupSchema: vi.fn(),
	/** Calls to other servers: the group host's space methods. */
	networkFetch: vi.fn<typeof fetch>()
}));
vi.mock('./declared', () => ({
	DECLARED_PAGE: 50,
	SERVERS_SHOWN: 50,
	upcomingGroups: mocks.upcomingGroups,
	groupLabels: mocks.groupLabels,
	groupServers: mocks.groupServers,
	cachedProfiles: vi.fn(),
	cacheProfile: mocks.cacheProfile,
	ensureGroupSchema: mocks.ensureGroupSchema
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
	forgetHeldAtGroupHost,
	groupHostSpaces,
	heldAtGroupHost,
	heldOf,
	isDeclared,
	listDeclaredGroups,
	listGroupServers,
	listUpcomingGroups,
	parseGroupProfile,
	readGroupLabels,
	readLinkedMeta,
	repoHasDeclaration,
	resolveGroup,
	storeCachedProfile,
	syncDeclarationIndex
} from './group';

const GROUP = 'did:plc:group';
const HOST = 'https://host.example';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
const kem = await fakeKemHost();
const spaceHosts: SpaceHosts = { repoHost: async () => HOST, kemKey: async () => kem.did };

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example/' });
	mocks.post.mockResolvedValue({ ok: true, data: {} });
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

	it('lists a page of declared groups in the order the index gives, asking for no profiles', async () => {
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
		expect(await listDeclaredGroups()).toEqual({ dids: ['did:plc:newer', GROUP], cursor: 'next' });
		const [nsid, { params }] = mocks.get.mock.calls[0];
		expect(nsid).toBe('rsvp.atmo.declaration.listDeclared');
		expect(params).toEqual({ limit: 50 });
	});

	it("asks for one server's groups, a search's, and the page after a cursor", async () => {
		mocks.get.mockResolvedValue({ ok: true, data: { records: [] } });
		expect(
			await listDeclaredGroups({ cursor: 'page2', server: 'https://pds.example', q: 'knit' })
		).toEqual({ dids: [], cursor: null });
		expect(mocks.get.mock.calls[0][1].params).toEqual({
			limit: 50,
			cursor: 'page2',
			server: 'https://pds.example',
			q: 'knit'
		});
	});

	it('reads the tables only once contrail and groups have made them, as on a fresh database', async () => {
		// contrail makes its tables when the Worker first uses it; groups add theirs after.
		let contrail = false;
		let groups = false;
		let make: () => void = () => {};
		mocks.ensureInit.mockReturnValue(
			new Promise<void>((resolve) => (make = resolve)).then(() => {
				contrail = true;
			})
		);
		// Its index is on contrail's events table.
		mocks.ensureGroupSchema.mockImplementation(async () => {
			if (!contrail) throw new Error('no such table: records_event');
			groups = true;
		});
		const ready = () => (groups ? null : new Error('no such table: group_profiles'));
		mocks.upcomingGroups.mockImplementation(async () => {
			const missing = ready();
			if (missing) throw missing;
			return { groups: [], cursor: null };
		});
		mocks.groupLabels.mockImplementation(async () => {
			const missing = ready();
			if (missing) throw missing;
			return new Map();
		});
		const upcoming = listUpcomingGroups();
		const labels = readGroupLabels([GROUP]);
		await vi.waitFor(() => expect(mocks.ensureInit).toHaveBeenCalledTimes(2));
		expect(mocks.upcomingGroups).not.toHaveBeenCalled();
		make();
		expect(await upcoming).toEqual({ groups: [], cursor: null });
		expect(await labels).toEqual(new Map());
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

	it('keeps a website only when it is an http or https URL', () => {
		const website = (value: unknown) =>
			parseGroupProfile({ displayName: 'Knitters', website: value })?.website;
		expect(website(' https://knit.example ')).toBe('https://knit.example/');
		expect(website('http://knit.example/club')).toBe('http://knit.example/club');
		for (const unsafe of [
			'javascript:alert(1)',
			'JAVASCRIPT:alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'ftp://knit.example',
			'//knit.example',
			'knit.example',
			'',
			42,
			null
		]) {
			expect(website(unsafe), String(unsafe)).toBeUndefined();
		}
	});
});

describe('readLinkedMeta', () => {
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

	it('reads how the group takes members, with one credential for every read', async () => {
		for (const [config, joinPolicy] of [
			[{ joinPolicy: 'approval' }, 'approval'],
			[{ joinPolicy: 'open' }, 'open'],
			[{ joinPolicy: 'x' }, null],
			[{}, 'approval']
		] as const) {
			const host = groupHost({
				'org.atgrp.about': about,
				'org.atgrp.config': config,
				'com.atproto.space.policy': policy(true)
			});
			expect(await readLinkedMeta(host.handle, GROUP, spaceHosts)).toEqual({
				profile: { name: 'Knitters', description: null },
				public: true,
				joinPolicy
			});
			expect(host.exchanges).toHaveLength(1);
		}
	});

	it("reads the about record, the config and the policy with a credential the group's session bought", async () => {
		const host = groupHost({
			'org.atgrp.about': about,
			'com.atproto.space.policy': policy(true)
		});
		expect(await readLinkedMeta(host.handle, GROUP, spaceHosts)).toEqual({
			profile: { name: 'Knitters', description: null },
			public: true,
			joinPolicy: 'approval'
		});

		// The session asks only for the delegation token, once for every record.
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
			'org.atgrp.about',
			'org.atgrp.config'
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
		expect((await readLinkedMeta(missing.handle, GROUP, spaceHosts)).public).toBe(false);
		const unset = groupHost({ 'org.atgrp.about': about, 'com.atproto.space.policy': policy() });
		expect((await readLinkedMeta(unset.handle, GROUP, spaceHosts)).public).toBe(false);
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
		await expect(readLinkedMeta(host.handle, GROUP, spaceHosts)).rejects.toThrow(
			'MAC of at:space/'
		);
	});

	it('is a refusal, not an outage, when the session holds no scope that reads it', async () => {
		const host = groupHost(
			{},
			{ delegate: () => Response.json({ error: 'ScopeMissing' }, { status: 403 }) }
		);
		const thrown = await readLinkedMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
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
		const thrown = await readLinkedMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toMatchObject({ nsid: 'com.atproto.space.getDelegationToken', status: 401 });
		expect(isAuthRefused(thrown)).toBe(true);
		expect(isRoleRefused(thrown)).toBe(false);
	});

	it('reads a credential the host refuses at the read as roles that no longer allow it', async () => {
		const host = groupHost(
			{},
			{ read: () => Response.json({ error: 'CredentialRevoked' }, { status: 401 }) }
		);
		const thrown = await readLinkedMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(XrpcError);
		expect(isRoleRefused(thrown)).toBe(true);
		expect(isAuthRefused(thrown)).toBe(false);
	});

	it('throws on anything but a record or RecordNotFound', async () => {
		const host = groupHost({}, { read: () => new Response('{}', { status: 502 }) });
		const thrown = await readLinkedMeta(host.handle, GROUP, spaceHosts).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(XrpcError);
		expect(isRoleRefused(thrown)).toBe(false);
		expect(isAuthRefused(thrown)).toBe(false);
	});
});

describe('repoHasDeclaration', () => {
	const repo = (answer: () => Response) => vi.fn<XrpcHandle>(async () => answer());

	it("is true when the group's repo has the declaration, and false when it has none", async () => {
		const found = repo(() => Response.json({ uri: 'at://x', value: {} }));
		expect(await repoHasDeclaration(found, GROUP)).toBe(true);
		expect(String(found.mock.calls[0][0])).toContain(`repo=${encodeURIComponent(GROUP)}`);
		const missing = repo(() => Response.json({ error: 'RecordNotFound' }, { status: 400 }));
		expect(await repoHasDeclaration(missing, GROUP)).toBe(false);
	});

	it('throws when the repo cannot say, rather than read it as no declaration', async () => {
		const down = repo(() => new Response('{}', { status: 502 }));
		await expect(repoHasDeclaration(down, GROUP)).rejects.toBeInstanceOf(XrpcError);
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

describe('cached group profiles', () => {
	const group = { did: GROUP, handle: 'knit.example' };

	it("keeps a public group's name and handle for visitors, and none of a private group's", async () => {
		const profile = { name: 'Knitters', description: 'Yarn' };
		await storeCachedProfile(group, { profile, public: true });
		expect(mocks.cacheProfile).toHaveBeenLastCalledWith(env.DB, GROUP, {
			...profile,
			handle: 'knit.example'
		});
		await storeCachedProfile(group, { profile, public: false });
		expect(mocks.cacheProfile).toHaveBeenLastCalledWith(env.DB, GROUP, null);
		await storeCachedProfile(group, { profile: null, public: true });
		expect(mocks.cacheProfile).toHaveBeenLastCalledWith(env.DB, GROUP, null);
	});
});

describe("the accounts this site's group host holds", () => {
	let kv: MemoryKV;
	const listRepos = () =>
		mocks.networkFetch.mock.calls.filter(([input]) => String(input).includes('listRepos'));

	/** The group host's listRepos: one page per entry, each a list of [did, active]. */
	function hostHolds(...pages: [string, boolean][][]) {
		mocks.networkFetch.mockImplementation(async (input) => {
			const cursor = new URL(String(input)).searchParams.get('cursor');
			const index = cursor ? Number(cursor) : 0;
			const repos = (pages[index] ?? []).map(([did, active]) => ({ did, active }));
			return Response.json({
				repos,
				...(index + 1 < pages.length ? { cursor: `${index + 1}` } : {})
			});
		});
	}

	beforeEach(async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		kv = memoryKV();
		Object.assign(env, { OAUTH_SESSIONS: kv });
		await forgetHeldAtGroupHost();
		hostHolds([[GROUP, true]]);
	});

	it("are read from every page of the host's listRepos, but inactive ones, and cached", async () => {
		hostHolds(
			[
				[GROUP, true],
				['did:plc:gone', false]
			],
			[['did:plc:second', true]]
		);
		expect(await heldAtGroupHost()).toEqual([GROUP, 'did:plc:second']);
		expect(String(listRepos()[0][0])).toBe(
			'https://host.example/xrpc/com.atproto.sync.listRepos?limit=1000'
		);
		expect(listRepos()).toHaveLength(2);
		expect(await heldAtGroupHost()).toEqual([GROUP, 'did:plc:second']);
		expect(listRepos()).toHaveLength(2);
		expect(kv.ttlOf('groups:held-at-host')).toBe(600);
	});

	it('are none for a host that never answers in time, and that is remembered for a minute', async () => {
		const limit = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
		try {
			mocks.networkFetch.mockImplementation(
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
		hostHolds([[GROUP, true]]);
		expect(await heldAtGroupHost()).toBeNull();
	});

	it('are asked for once by two lists that want them at the same time', async () => {
		expect(await Promise.all([heldAtGroupHost(), heldAtGroupHost()])).toEqual([[GROUP], [GROUP]]);
		expect(listRepos()).toHaveLength(1);
	});

	it("decide the host's own list and its places, and with the host unreachable none count", async () => {
		mocks.ensureInit.mockResolvedValue(undefined);
		mocks.upcomingGroups.mockResolvedValue({ groups: [], cursor: null });
		mocks.groupServers.mockResolvedValue([]);
		await listUpcomingGroups();
		await listGroupServers();
		const home = { origin: HOST, held: [GROUP] };
		expect(mocks.upcomingGroups).toHaveBeenCalledWith(env.DB, expect.any(String), null, home);
		expect(mocks.groupServers).toHaveBeenCalledWith(env.DB, expect.any(String), 50, home);
		expect(await heldOf(HOST, [GROUP, 'did:plc:claims'])).toEqual([GROUP]);
		// Any other server's list is as its accounts name it: nothing there can be asked cheaply.
		expect(await heldOf('https://elsewhere.example', ['did:plc:claims'])).toEqual([
			'did:plc:claims'
		]);

		await forgetHeldAtGroupHost();
		mocks.networkFetch.mockRejectedValue(new Error('offline'));
		await listUpcomingGroups();
		expect(mocks.upcomingGroups).toHaveBeenLastCalledWith(env.DB, expect.any(String), null, {
			origin: HOST,
			held: []
		});
		expect(await heldOf(HOST, [GROUP])).toEqual([]);
	});
});

describe('the limits a deployment may set on the groups list', () => {
	const SETTINGS = ['GROUP_SERVERS_SHOWN', 'GROUP_HOST_ACCOUNTS_READ', 'GROUP_HOST_RETRY_SECONDS'];
	let kv: MemoryKV;

	beforeEach(async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		kv = memoryKV();
		Object.assign(env, { OAUTH_SESSIONS: kv });
		for (const name of SETTINGS) Reflect.deleteProperty(env, name);
		await forgetHeldAtGroupHost();
		mocks.ensureInit.mockResolvedValue(undefined);
		mocks.groupServers.mockResolvedValue([]);
	});

	it.each(['', ' ', 'many', '0', '-3', '2.5'])(
		'keep the default for %j, as for no setting',
		async (value) => {
			Object.assign(env, { GROUP_SERVERS_SHOWN: value });
			await listGroupServers();
			expect(mocks.groupServers).toHaveBeenCalledWith(
				env.DB,
				expect.any(String),
				50,
				expect.anything()
			);
		}
	);

	it('name as many servers as set', async () => {
		Object.assign(env, { GROUP_SERVERS_SHOWN: ' 7 ' });
		await listGroupServers();
		expect(mocks.groupServers).toHaveBeenCalledWith(
			env.DB,
			expect.any(String),
			7,
			expect.anything()
		);
	});

	it("read as many of the host's accounts as set, a page of 1000 at a time", async () => {
		Object.assign(env, { GROUP_HOST_ACCOUNTS_READ: '1500' });
		mocks.networkFetch.mockImplementation(async (input) => {
			const page = Number(new URL(String(input)).searchParams.get('cursor') ?? 0);
			return Response.json({ repos: [{ did: `did:plc:${page}` }], cursor: `${page + 1}` });
		});
		expect(await heldAtGroupHost()).toEqual(['did:plc:0', 'did:plc:1']);
	});

	it('keep a host that did not answer out of the list for as long as set, a minute at least', async () => {
		mocks.networkFetch.mockRejectedValue(new Error('offline'));
		Object.assign(env, { GROUP_HOST_RETRY_SECONDS: '300' });
		expect(await heldAtGroupHost()).toBeNull();
		expect(kv.ttlOf('groups:held-at-host')).toBe(300);
		await forgetHeldAtGroupHost();
		Object.assign(env, { GROUP_HOST_RETRY_SECONDS: '5' });
		expect(await heldAtGroupHost()).toBeNull();
		expect(kv.ttlOf('groups:held-at-host')).toBe(60);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), resolve: vi.fn() }));
vi.mock('#lib/contrail/index.js', () => ({
	getServerClient: () => ({ get: mocks.get, post: mocks.post })
}));
vi.mock('#lib/atproto/network.js', () => ({ atprotoNetwork: () => undefined }));
vi.mock('@svelte-atproto/oauth/network', () => ({
	createActorResolver: () => ({ resolve: mocks.resolve })
}));

import {
	atGroupHost,
	isDeclared,
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

	it('lists declared groups newest first with no profiles', async () => {
		mocks.get.mockResolvedValue({
			ok: true,
			data: { records: [{ did: GROUP, time_us: 2_000_000 }] }
		});
		expect(await listDeclaredGroups()).toEqual([{ did: GROUP, indexedAt: 2000 }]);
		expect(mocks.get.mock.calls[0][1].params).not.toHaveProperty('profiles');
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
	it('reads the profile and access out of the meta space', async () => {
		const handle = pds({
			'group.opensocial.profile': { displayName: 'Knitters' },
			'group.opensocial.access': { public: true }
		});
		expect(await readGroupMeta(handle, GROUP)).toEqual({
			profile: { name: 'Knitters', description: null },
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

	it('deletes the declaration to unlist', async () => {
		const handle = pds({});
		await unlistGroup(handle, GROUP);
		expect(handle.mock.calls[0][0]).toBe('/xrpc/com.atproto.repo.deleteRecord');
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

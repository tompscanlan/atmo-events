import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { isHttpError } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { XrpcError } from './xrpc';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	isDeclared: vi.fn(),
	readGroupMeta: vi.fn(),
	repoHasDeclaration: vi.fn(),
	readCachedProfiles: vi.fn(),
	storeCachedProfile: vi.fn(),
	atGroupHost: vi.fn(),
	groupSession: vi.fn(),
	groupSignInAvailable: vi.fn(),
	hasGroupSession: vi.fn()
}));
vi.mock('./group', () => ({
	resolveGroup: mocks.resolveGroup,
	isDeclared: mocks.isDeclared,
	readGroupMeta: mocks.readGroupMeta,
	repoHasDeclaration: mocks.repoHasDeclaration,
	readCachedProfiles: mocks.readCachedProfiles,
	storeCachedProfile: mocks.storeCachedProfile,
	atGroupHost: mocks.atGroupHost
}));
vi.mock('./sign-in', () => ({
	groupSession: mocks.groupSession,
	groupHandle: () => vi.fn(),
	groupSignInAvailable: mocks.groupSignInAvailable,
	hasGroupSession: mocks.hasGroupSession
}));

import { GROUP_NOT_FOUND, groupView, requireGroupWriter, requireStoredLink } from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const resolved = { did: GROUP, handle: 'knit.example', pds: 'https://host.example' };
const meta = { profile: { name: 'Knitters', description: 'Yarn' }, public: true };

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.resolveGroup.mockResolvedValue(resolved);
	mocks.readCachedProfiles.mockResolvedValue(new Map());
	mocks.storeCachedProfile.mockResolvedValue(undefined);
	mocks.groupSession.mockResolvedValue(null);
	mocks.groupSignInAvailable.mockReturnValue(true);
	mocks.atGroupHost.mockReturnValue(true);
});

describe('groupView for a visitor', () => {
	it('is the same 404 with groups off, for an unknown actor, and for an undeclared group', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		await expect(groupView(GROUP, null)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});

		mocks.resolveGroup.mockResolvedValueOnce(null);
		await expect(groupView('nobody.example', null)).rejects.toMatchObject({ status: 404 });

		// Worded as an unknown address: off-state.test.ts.
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(groupView(GROUP, null)).rejects.toMatchObject({ status: 404 });
	});

	it('is a 503 when the index cannot say, never a 404', async () => {
		mocks.isDeclared.mockRejectedValue(new Error('index down'));
		await expect(groupView(GROUP, null)).rejects.toMatchObject({ status: 503 });
	});

	it("shows a declared group by its cached profile's name", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([[GROUP, { name: 'Knitters', description: 'Yarn', handle: 'knit.example' }]])
		);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			did: GROUP,
			name: 'Knitters',
			description: 'Yarn',
			linked: null,
			relink: false,
			hasLink: false,
			atHost: true
		});
	});

	it('falls back to the handle when there is no cached profile', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		expect((await groupView(GROUP, null)).name).toBe('knit.example');
	});
});

describe('groupView for someone who linked the group', () => {
	beforeEach(() => {
		mocks.groupSession.mockResolvedValue({ did: GROUP });
	});

	it('reads as the group, caches its profile, and needs no declaration', async () => {
		mocks.readGroupMeta.mockResolvedValue({ ...meta, public: false });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		const view = await groupView(GROUP, ALICE);
		expect(view).toMatchObject({
			name: 'Knitters',
			linked: { meta: { public: false }, listed: false },
			relink: false,
			hasLink: true
		});
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.storeCachedProfile).toHaveBeenCalledWith(resolved, { ...meta, public: false });
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});

	it('asks to link again when the PDS refuses the session', async () => {
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 401, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			linked: null,
			relink: true,
			hasLink: true
		});
		expect(mocks.storeCachedProfile).not.toHaveBeenCalled();
	});

	it('asks to link again when the session can no longer refresh', async () => {
		mocks.readGroupMeta.mockRejectedValue(new TokenRefreshError(GROUP, 'invalid_grant'));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: true });
	});

	it('asks to link again when the stored session does not restore', async () => {
		mocks.groupSession.mockRejectedValue(new Error('corrupt session'));
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			linked: null,
			relink: true,
			hasLink: true
		});
	});

	it('is the same 404 as for anyone when a broken link points at an undeclared group', async () => {
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([[GROUP, { name: 'Old Name', description: 'Old', handle: 'knit.example' }]])
		);
		mocks.isDeclared.mockResolvedValue(false);
		mocks.groupSession.mockRejectedValue(new Error('corrupt session'));
		await expect(groupView(GROUP, ALICE)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});

		mocks.groupSession.mockResolvedValue({ did: GROUP });
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 401, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await expect(groupView(GROUP, ALICE)).rejects.toMatchObject({ status: 404 });
	});

	it.each(['ScopeMissingError', 'Forbidden'])(
		'shows the group without the link when its roles no longer allow reading it (%s)',
		async (name) => {
			mocks.readGroupMeta.mockRejectedValue(
				new XrpcError('com.atproto.space.getRecord', 403, name)
			);
			mocks.repoHasDeclaration.mockResolvedValue(true);
			mocks.isDeclared.mockResolvedValue(true);
			expect(await groupView(GROUP, ALICE)).toMatchObject({
				linked: null,
				relink: false,
				hasLink: true
			});
			expect(mocks.storeCachedProfile).not.toHaveBeenCalled();
		}
	);

	it('is the same 404 as for anyone when the link no longer reads an undeclared group', async () => {
		mocks.readGroupMeta.mockRejectedValue(
			new XrpcError('com.atproto.space.getRecord', 403, 'ScopeMissingError')
		);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		mocks.isDeclared.mockResolvedValue(false);
		await expect(groupView(GROUP, ALICE)).rejects.toMatchObject({ status: 404 });
	});

	it("fails the page, rather than offering a link, when the group's PDS is down", async () => {
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 502, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		const failure = await groupView(GROUP, ALICE).catch((e: unknown) => e);
		// Not an HttpError, so SvelteKit renders the page as a 500, whatever the PDS answered.
		expect(failure).toBeInstanceOf(XrpcError);
		expect(isHttpError(failure)).toBe(false);
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});
});

describe('requireGroupWriter', () => {
	it('is the same 404 without a linked session', async () => {
		await expect(requireGroupWriter(GROUP, ALICE)).rejects.toMatchObject({ status: 404 });
		await expect(requireGroupWriter(GROUP, null)).rejects.toMatchObject({ status: 404 });
		expect(mocks.groupSession).toHaveBeenCalledOnce();
	});

	it("writes with the caller's own session as the group", async () => {
		mocks.groupSession.mockResolvedValue({ did: GROUP });
		expect(await requireGroupWriter(GROUP, ALICE)).toMatchObject({ did: GROUP });
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

describe('requireStoredLink', () => {
	it("takes the caller's stored link without restoring it", async () => {
		mocks.hasGroupSession.mockResolvedValue(true);
		expect(await requireStoredLink(GROUP, ALICE)).toBe(ALICE);
		expect(mocks.hasGroupSession).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.groupSession).not.toHaveBeenCalled();
	});

	it('is the same 404 with no link stored, signed out, or with groups off', async () => {
		mocks.hasGroupSession.mockResolvedValue(false);
		await expect(requireStoredLink(GROUP, ALICE)).rejects.toMatchObject({ status: 404 });
		await expect(requireStoredLink(GROUP, null)).rejects.toMatchObject({ status: 404 });
		mocks.hasGroupSession.mockResolvedValue(true);
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(requireStoredLink(GROUP, ALICE)).rejects.toMatchObject({ status: 404 });
	});
});

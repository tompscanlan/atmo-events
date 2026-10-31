import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { XrpcError } from './xrpc';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	isDeclared: vi.fn(),
	readGroupMeta: vi.fn(),
	repoHasDeclaration: vi.fn(),
	readCards: vi.fn(),
	storeCard: vi.fn(),
	atGroupHost: vi.fn(),
	groupSession: vi.fn(),
	groupSignInAvailable: vi.fn()
}));
vi.mock('./group', () => ({
	resolveGroup: mocks.resolveGroup,
	isDeclared: mocks.isDeclared,
	readGroupMeta: mocks.readGroupMeta,
	repoHasDeclaration: mocks.repoHasDeclaration,
	readCards: mocks.readCards,
	storeCard: mocks.storeCard,
	atGroupHost: mocks.atGroupHost
}));
vi.mock('./sign-in', () => ({
	groupSession: mocks.groupSession,
	groupHandle: () => vi.fn(),
	groupSignInAvailable: mocks.groupSignInAvailable
}));

import { GROUP_NOT_FOUND, groupView, requireGroupWriter } from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const resolved = { did: GROUP, handle: 'knit.example', pds: 'https://host.example' };
const meta = { profile: { name: 'Knitters', description: 'Yarn' }, public: true };

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.resolveGroup.mockResolvedValue(resolved);
	mocks.readCards.mockResolvedValue(new Map());
	mocks.storeCard.mockResolvedValue(undefined);
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

		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(groupView(GROUP, null)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
	});

	it('is a 503 when the index cannot say, never a 404', async () => {
		mocks.isDeclared.mockRejectedValue(new Error('index down'));
		await expect(groupView(GROUP, null)).rejects.toMatchObject({ status: 503 });
	});

	it("shows a declared group by its card's name", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readCards.mockResolvedValue(
			new Map([[GROUP, { name: 'Knitters', description: 'Yarn', handle: 'knit.example' }]])
		);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			did: GROUP,
			name: 'Knitters',
			description: 'Yarn',
			linked: null,
			relink: false,
			atHost: true
		});
	});

	it('falls back to the handle when there is no card', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		expect((await groupView(GROUP, null)).name).toBe('knit.example');
	});
});

describe('groupView for someone who linked the group', () => {
	beforeEach(() => {
		mocks.groupSession.mockResolvedValue({ did: GROUP });
	});

	it('reads as the group, stores the card, and needs no declaration', async () => {
		mocks.readGroupMeta.mockResolvedValue({ ...meta, public: false });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		const view = await groupView(GROUP, ALICE);
		expect(view).toMatchObject({
			name: 'Knitters',
			linked: { meta: { public: false }, listed: false },
			relink: false
		});
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.storeCard).toHaveBeenCalledWith(resolved, { ...meta, public: false });
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});

	it('asks to link again when the PDS refuses the session', async () => {
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 401, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: true });
		expect(mocks.storeCard).not.toHaveBeenCalled();
	});

	it('asks to link again when the session can no longer refresh', async () => {
		mocks.readGroupMeta.mockRejectedValue(new TokenRefreshError(GROUP, 'invalid_grant'));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: true });
	});

	it('asks to link again when the stored session does not restore', async () => {
		mocks.groupSession.mockRejectedValue(new Error('corrupt session'));
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: true });
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});

	it.each(['ScopeMissingError', 'Forbidden'])(
		'shows the group without the link when its roles no longer allow reading it (%s)',
		async (name) => {
			mocks.readGroupMeta.mockRejectedValue(
				new XrpcError('com.atproto.space.getRecord', 403, name)
			);
			mocks.repoHasDeclaration.mockResolvedValue(true);
			mocks.isDeclared.mockResolvedValue(true);
			expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: false });
			expect(mocks.storeCard).not.toHaveBeenCalled();
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

	it("fails, rather than offering a link, when the group's PDS is down", async () => {
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 502, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await expect(groupView(GROUP, ALICE)).rejects.toMatchObject({ status: 502 });
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { XrpcError } from './xrpc';
import { CALENDAR_RSVP_SCOPE } from '../scopes';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	isDeclared: vi.fn(),
	readGroupMeta: vi.fn(),
	repoHasDeclaration: vi.fn(),
	readCards: vi.fn(),
	storeCard: vi.fn(),
	atGroupHost: vi.fn(),
	groupSession: vi.fn(),
	groupSignInAvailable: vi.fn(),
	readMetaAsPerson: vi.fn(),
	groupSpacesOf: vi.fn(),
	isMemberAsPerson: vi.fn(),
	accept: vi.fn()
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

vi.mock('./person', () => ({
	readMetaAsPerson: mocks.readMetaAsPerson,
	groupSpacesOf: mocks.groupSpacesOf,
	isMemberAsPerson: mocks.isMemberAsPerson
}));
vi.mock('./acceptance', () => ({ accept: mocks.accept }));

import { GROUP_NOT_FOUND, GROUP_UNCHECKED, groupView, requireGroupWriter } from './context';
import { SpaceAccessDenied } from './space-credential';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const resolved = { did: GROUP, handle: 'knit.example', pds: 'https://host.example' };
const meta = { profile: { name: 'Knitters', description: 'Yarn' }, public: true };
const VISITOR = { did: null, session: null };
const AS_ALICE = { did: ALICE, session: null } as const;
const NOT_FOUND = { status: 404, body: { message: GROUP_NOT_FOUND } };
const GET_RECORD = 'com.atproto.space.getRecord';

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.resolveGroup.mockResolvedValue(resolved);
	mocks.readCards.mockResolvedValue(new Map());
	mocks.storeCard.mockResolvedValue(undefined);
	mocks.groupSession.mockResolvedValue(null);
	mocks.groupSignInAvailable.mockReturnValue(true);
	mocks.atGroupHost.mockReturnValue(true);
	mocks.isMemberAsPerson.mockResolvedValue(false);
});

describe('groupView for a visitor', () => {
	it.each([
		['with groups off', () => Reflect.deleteProperty(env, 'GROUP_HOST_URL')],
		['for an unknown actor', () => mocks.resolveGroup.mockResolvedValueOnce(null)],
		['for an undeclared group', () => mocks.isDeclared.mockResolvedValue(false)]
	])('is the same 404 %s', async (_why, arrange) => {
		arrange();
		await expect(groupView(GROUP, VISITOR)).rejects.toMatchObject(NOT_FOUND);
	});

	it('is a 503 when the index cannot say, never a 404', async () => {
		mocks.isDeclared.mockRejectedValue(new Error('index down'));
		await expect(groupView(GROUP, VISITOR)).rejects.toMatchObject({ status: 503 });
	});

	it("shows a declared group by its card's name", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readCards.mockResolvedValue(
			new Map([[GROUP, { name: 'Knitters', description: 'Yarn', handle: 'knit.example' }]])
		);
		expect(await groupView(GROUP, AS_ALICE)).toMatchObject({
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
		expect((await groupView(GROUP, VISITOR)).name).toBe('knit.example');
	});
});

describe('groupView for someone who linked the group', () => {
	beforeEach(() => {
		mocks.groupSession.mockResolvedValue({ did: GROUP });
	});

	it('reads as the group, stores the card, and needs no declaration', async () => {
		mocks.readGroupMeta.mockResolvedValue({ ...meta, public: false });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		const view = await groupView(GROUP, AS_ALICE);
		expect(view).toMatchObject({
			name: 'Knitters',
			linked: { meta: { public: false }, listed: false },
			relink: false
		});
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.storeCard).toHaveBeenCalledWith(resolved, { ...meta, public: false });
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});

	it.each([
		['the PDS refuses the session', mocks.readGroupMeta, new XrpcError(GET_RECORD, 401, null)],
		[
			'the session can no longer refresh',
			mocks.readGroupMeta,
			new TokenRefreshError(GROUP, 'invalid_grant')
		],
		['the stored session does not restore', mocks.groupSession, new Error('corrupt session')]
	])('asks to link again when %s', async (_why, failing, e) => {
		failing.mockRejectedValue(e);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await groupView(GROUP, AS_ALICE)).toMatchObject({ linked: null, relink: true });
		expect(mocks.storeCard).not.toHaveBeenCalled();
		expect(mocks.isDeclared).not.toHaveBeenCalled();
	});

	it("fails, rather than offering a link, when the group's PDS is down", async () => {
		mocks.readGroupMeta.mockRejectedValue(new XrpcError(GET_RECORD, 502, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		await expect(groupView(GROUP, AS_ALICE)).rejects.toMatchObject({ status: 502 });
	});
});

describe('requireGroupWriter', () => {
	it('is the same 404 without a linked session', async () => {
		await expect(requireGroupWriter(GROUP, ALICE)).rejects.toMatchObject(NOT_FOUND);
		await expect(requireGroupWriter(GROUP, null)).rejects.toMatchObject(NOT_FOUND);
		expect(mocks.groupSession).toHaveBeenCalledOnce();
	});

	it("writes with the caller's own session as the group", async () => {
		mocks.groupSession.mockResolvedValue({ did: GROUP });
		expect(await requireGroupWriter(GROUP, ALICE)).toMatchObject({ did: GROUP });
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

describe("groupView with the caller's own access", () => {
	const GRANTED = `atproto space:group.opensocial.meta?authority=*&action=read space:group.opensocial.members?authority=*&action=read_self ${CALENDAR_RSVP_SCOPE}`;
	const signedIn = (scope = GRANTED) => ({
		did: ALICE,
		session: { did: ALICE, getTokenInfo: async () => ({ scope }), handle: vi.fn() }
	});
	const view = (scope?: string) => groupView(GROUP, signedIn(scope) as never);

	it('shows a private group to someone the host lets in, without its declaration', async () => {
		mocks.readMetaAsPerson.mockResolvedValue({ ...meta, public: false });
		expect(await view()).toMatchObject({
			name: 'Knitters',
			personal: { public: false },
			askAccess: false
		});
		expect(mocks.isDeclared).not.toHaveBeenCalled();
		expect(mocks.storeCard).toHaveBeenCalledWith(resolved, { ...meta, public: false });
	});

	const WITH_ACCEPTANCE = `${GRANTED} space:group.opensocial.members?authority=*&skey=self&collection=group.opensocial.acceptance`;

	it('confirms a member on the visit, only with a grant that can write the acceptance', async () => {
		mocks.readMetaAsPerson.mockResolvedValue(meta);
		mocks.isMemberAsPerson.mockResolvedValue(true);
		mocks.accept.mockResolvedValue(true);
		expect(await view()).toMatchObject({ member: true });
		expect(mocks.accept).not.toHaveBeenCalled();
		await view(WITH_ACCEPTANCE);
		expect(mocks.accept).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ did: ALICE }),
			GROUP
		);
	});

	it('writes nothing for someone the host does not count a member', async () => {
		mocks.readMetaAsPerson.mockResolvedValue(meta);
		mocks.isMemberAsPerson.mockResolvedValue(false);
		expect(await view(WITH_ACCEPTANCE)).toMatchObject({ member: false });
		expect(mocks.accept).not.toHaveBeenCalled();
	});

	it('is the same 404 when the host turns them away from an undeclared group', async () => {
		mocks.readMetaAsPerson.mockRejectedValue(new SpaceAccessDenied('s', '403 UserNotAuthorized'));
		mocks.isDeclared.mockResolvedValue(false);
		await expect(view()).rejects.toMatchObject(NOT_FOUND);
		expect(mocks.groupSpacesOf).not.toHaveBeenCalled();
	});

	it('says "try again", never acts, when SpaceNotFound comes for a group they wrote into', async () => {
		mocks.readMetaAsPerson.mockRejectedValue(new SpaceAccessDenied('s', '400 SpaceNotFound', true));
		mocks.groupSpacesOf.mockResolvedValue([GROUP]);
		mocks.isDeclared.mockResolvedValue(false);
		await expect(view()).rejects.toMatchObject({ status: 503, body: { message: GROUP_UNCHECKED } });
	});

	it('is the same 404 on SpaceNotFound for a group they never wrote into', async () => {
		mocks.readMetaAsPerson.mockRejectedValue(new SpaceAccessDenied('s', '400 SpaceNotFound', true));
		mocks.groupSpacesOf.mockResolvedValue(['did:plc:other']);
		mocks.isDeclared.mockResolvedValue(false);
		await expect(view()).rejects.toMatchObject(NOT_FOUND);
	});

	it('still shows a declared group when the host read fails', async () => {
		mocks.readMetaAsPerson.mockRejectedValue(new Error('host down'));
		mocks.isDeclared.mockResolvedValue(true);
		expect(await view()).toMatchObject({ personal: null, name: 'knit.example' });
	});

	it("reads nothing with the caller's access for a group at another host", async () => {
		mocks.atGroupHost.mockReturnValue(false);
		mocks.isDeclared.mockResolvedValue(true);
		expect(await view()).toMatchObject({ personal: null, askAccess: false, atHost: false });
		expect(mocks.readMetaAsPerson).not.toHaveBeenCalled();
	});

	it('offers to ask for the group scopes when the sign-in lacks them', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		expect(await view('atproto')).toMatchObject({ askAccess: true, personal: null });
		expect(mocks.readMetaAsPerson).not.toHaveBeenCalled();
	});
});

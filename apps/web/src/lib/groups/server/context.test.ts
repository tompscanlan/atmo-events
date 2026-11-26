import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, waitUntil } from 'cloudflare:workers';
import { isHttpError } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { GROUP_SETTINGS_SCOPES } from '../scopes';
import { XrpcError } from './xrpc';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	isDeclared: vi.fn(),
	readGroupMeta: vi.fn(),
	repoHasDeclaration: vi.fn(),
	syncDeclarationIndex: vi.fn(),
	readCachedProfiles: vi.fn(),
	storeCachedProfile: vi.fn(),
	atGroupHost: vi.fn(),
	groupSession: vi.fn(),
	groupSignInAvailable: vi.fn(),
	hasGroupSession: vi.fn(),
	linkAskedCurrentScope: vi.fn(),
	unfinishedGroup: vi.fn(),
	readMetaAsPerson: vi.fn(),
	isMemberAsPerson: vi.fn(),
	actorGroups: vi.fn(),
	confirmMembership: vi.fn()
}));
vi.mock('./group', () => ({
	resolveGroup: mocks.resolveGroup,
	isDeclared: mocks.isDeclared,
	readGroupMeta: mocks.readGroupMeta,
	repoHasDeclaration: mocks.repoHasDeclaration,
	syncDeclarationIndex: mocks.syncDeclarationIndex,
	readCachedProfiles: mocks.readCachedProfiles,
	storeCachedProfile: mocks.storeCachedProfile,
	atGroupHost: mocks.atGroupHost
}));
vi.mock('./sign-in', () => ({
	groupSession: mocks.groupSession,
	groupHandle: () => vi.fn(),
	groupSignInAvailable: mocks.groupSignInAvailable,
	hasGroupSession: mocks.hasGroupSession,
	linkAskedCurrentScope: mocks.linkAskedCurrentScope
}));
vi.mock('./create', () => ({ unfinishedGroup: mocks.unfinishedGroup }));
vi.mock('./person', () => ({
	personReader: () => ({}),
	readMetaAsPerson: mocks.readMetaAsPerson,
	isMemberAsPerson: mocks.isMemberAsPerson
}));
vi.mock('./host', () => ({ actorGroups: mocks.actorGroups }));
vi.mock('./confirmation', () => ({ confirmMembership: mocks.confirmMembership }));

import {
	GROUP_NOT_FOUND,
	GROUP_UNCHECKED,
	groupView,
	requireGroupWriter,
	requireStoredLink
} from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
/** The scope the host grants an admin's session, and a member's. */
const ADMIN_SCOPE = [
	'atproto',
	`space:org.atgrp.meta?authority=${GROUP}&action=read`,
	'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
	'blob?accept=image/*',
	...GROUP_SETTINGS_SCOPES.map((scope) => scope.replace('authority=self', `authority=${GROUP}`))
].join(' ');
const MEMBER_SCOPE = `atproto space:org.atgrp.meta?authority=${GROUP}&action=read`;
const linkedSession = (scope = ADMIN_SCOPE) => ({
	did: GROUP,
	getTokenInfo: vi.fn(async () => ({ scope }))
});
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
	mocks.linkAskedCurrentScope.mockResolvedValue(true);
	mocks.unfinishedGroup.mockResolvedValue(null);
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
		mocks.groupSession.mockResolvedValue(linkedSession());
	});

	it('reads as the group, caches its profile, and needs no declaration', async () => {
		mocks.readGroupMeta.mockResolvedValue({ ...meta, public: false });
		mocks.repoHasDeclaration.mockResolvedValue(false);
		const view = await groupView(GROUP, ALICE);
		expect(view).toMatchObject({
			name: 'Knitters',
			linked: {
				meta: { public: false },
				listed: false,
				can: { post: true, list: true, settings: true },
				reapprove: false,
				unfinished: false
			},
			relink: false,
			hasLink: true
		});
		expect(mocks.groupSession).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.storeCachedProfile).toHaveBeenCalledWith(resolved, { ...meta, public: false });
		expect(mocks.isDeclared).not.toHaveBeenCalled();
		expect(mocks.syncDeclarationIndex).toHaveBeenCalledWith(GROUP, false);
	});

	it("offers only what the session's granted scope allows", async () => {
		mocks.groupSession.mockResolvedValue(linkedSession(MEMBER_SCOPE));
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		const view = await groupView(GROUP, ALICE);
		expect(view.linked).toMatchObject({
			can: { post: false, list: false, settings: false },
			reapprove: false
		});
		expect(view.relink).toBe(false);
	});

	it('offers to approve again a link approved for less than is asked now, and that lacks some of it', async () => {
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		mocks.linkAskedCurrentScope.mockResolvedValue(false);
		mocks.groupSession.mockResolvedValue(linkedSession(MEMBER_SCOPE));
		expect((await groupView(GROUP, ALICE)).linked).toMatchObject({ reapprove: true });
		// Once it holds everything, there is nothing to approve again.
		mocks.groupSession.mockResolvedValue(linkedSession(ADMIN_SCOPE));
		expect((await groupView(GROUP, ALICE)).linked).toMatchObject({ reapprove: false });
		expect(mocks.linkAskedCurrentScope).toHaveBeenCalledWith(GROUP, ALICE);
	});

	it("says when setting up a group the caller made here didn't finish", async () => {
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.unfinishedGroup.mockResolvedValue({ did: GROUP, handle: 'knit.example' });
		expect((await groupView(GROUP, ALICE)).linked).toMatchObject({ unfinished: true });
		expect(mocks.unfinishedGroup).toHaveBeenCalledWith(ALICE, GROUP);
	});

	it('asks to link again when the session cannot say what it was granted', async () => {
		const broken = linkedSession();
		broken.getTokenInfo.mockRejectedValue(new TokenRefreshError(GROUP, 'invalid_grant'));
		mocks.groupSession.mockResolvedValue(broken);
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, relink: true });
	});

	it('shows a group the host listed itself as listed, and has the index follow its repo', async () => {
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.syncDeclarationIndex.mockResolvedValue(undefined);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			linked: { meta: { public: true }, listed: true },
			relink: false
		});
		expect(mocks.syncDeclarationIndex).toHaveBeenCalledWith(GROUP, true);
	});

	it('leaves the index alone for a link that no longer reads the group', async () => {
		mocks.readGroupMeta.mockRejectedValue(
			new XrpcError('com.atproto.space.getDelegationToken', 403, 'NotAuthorized')
		);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		mocks.isDeclared.mockResolvedValue(true);
		await groupView(GROUP, ALICE);
		expect(mocks.syncDeclarationIndex).not.toHaveBeenCalled();
	});

	it('asks to link again when the PDS refuses the session', async () => {
		mocks.readGroupMeta.mockRejectedValue(
			new XrpcError('com.atproto.space.getDelegationToken', 401, 'invalid_token')
		);
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

	// Only what a visitor could learn anyway, the handle, so they can unlink it: never a cached name.
	const bareView = {
		name: 'knit.example',
		description: null,
		linked: null,
		hasLink: true
	};

	it('shows a broken link to an undeclared group bare, so it can still be unlinked', async () => {
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([[GROUP, { name: 'Old Name', description: 'Old', handle: 'knit.example' }]])
		);
		mocks.isDeclared.mockResolvedValue(false);
		mocks.groupSession.mockRejectedValue(new Error('corrupt session'));
		expect(await groupView(GROUP, ALICE)).toEqual(
			expect.objectContaining({ ...bareView, relink: true })
		);

		mocks.groupSession.mockResolvedValue(linkedSession());
		mocks.readGroupMeta.mockRejectedValue(
			new XrpcError('com.atproto.space.getDelegationToken', 401, 'invalid_token')
		);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toEqual(
			expect.objectContaining({ ...bareView, relink: true })
		);
		expect(mocks.readCachedProfiles).not.toHaveBeenCalled();
	});

	it('is the same 404 for an undeclared group to someone with no link stored', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.groupSession.mockResolvedValue(null);
		await expect(groupView(GROUP, ALICE)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
	});

	it.each([
		['the PDS', new XrpcError('com.atproto.space.getRecord', 403, 'ScopeMissingError')],
		['the PDS', new XrpcError('com.atproto.space.getRecord', 403, 'Forbidden')],
		// A group host's own names, at the delegation for the meta space.
		['the group host', new XrpcError('com.atproto.space.getDelegationToken', 403, 'ScopeMissing')],
		['the group host', new XrpcError('com.atproto.space.getDelegationToken', 403, 'NotAuthorized')],
		['the space', new SpaceAccessDenied(META, '403 ScopeMissing')],
		['the space', new SpaceAccessDenied(META, '400 SpaceNotFound')],
		// The credential it bought, refused at the read: not the session, so linking again won't help.
		['the space', new XrpcError('com.atproto.space.getRecord', 401, 'CredentialRevoked')],
		['the space', new XrpcError('com.atproto.space.getRecord', 401, 'MissingJwt')]
	])(
		'shows the group without the link when its roles no longer allow reading it (%s: %s)',
		async (_from, refusal) => {
			mocks.readGroupMeta.mockRejectedValue(refusal);
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

	it('shows an undeclared group bare when the link no longer reads it, so it can be unlinked', async () => {
		mocks.readGroupMeta.mockRejectedValue(
			new XrpcError('com.atproto.space.getRecord', 403, 'ScopeMissingError')
		);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		mocks.isDeclared.mockResolvedValue(false);
		expect(await groupView(GROUP, ALICE)).toEqual(
			expect.objectContaining({ ...bareView, relink: false })
		);
		expect(mocks.readCachedProfiles).not.toHaveBeenCalled();
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
		mocks.groupSession.mockResolvedValue(linkedSession());
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

describe('groupView for a person with their own group permissions', () => {
	/** The participate set as a PDS hands it back expanded, with "your groups". */
	const PARTICIPATE = [
		'atproto',
		'space:org.atgrp.meta?authority=*&skey=self&action=read',
		'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation',
		'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
		'rpc:org.atgrp.internal.getActorGroups?aud=*'
	].join(' ');
	const person = (scope = PARTICIPATE) => ({ did: ALICE, scope, handle: vi.fn() });
	const personal = { ...meta, joinPolicy: 'approval' };

	beforeEach(() => {
		vi.mocked(waitUntil).mockClear();
		mocks.readMetaAsPerson.mockResolvedValue(personal);
		mocks.isMemberAsPerson.mockResolvedValue(false);
	});

	it('reads the group as they may see it, with how it takes members, and asks nothing more', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({
			name: 'Knitters',
			personal: { public: true, joinPolicy: 'approval' },
			member: false,
			askAccess: false
		});
		expect(mocks.storeCachedProfile).toHaveBeenCalledWith(resolved, personal);
		expect(waitUntil).not.toHaveBeenCalled();
	});

	it('shows a private group to its member without a declaration, and writes their confirmation', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.readMetaAsPerson.mockResolvedValue({ ...personal, public: false });
		mocks.isMemberAsPerson.mockResolvedValue(true);
		const caller = person();
		expect(await groupView(GROUP, ALICE, caller)).toMatchObject({
			name: 'Knitters',
			personal: { public: false },
			member: true
		});
		expect(mocks.isDeclared).not.toHaveBeenCalled();
		expect(waitUntil).toHaveBeenCalledOnce();
		expect(mocks.confirmMembership).toHaveBeenCalledWith(caller, GROUP);
	});

	it('writes no confirmation for a member whose sign-in cannot write it', async () => {
		mocks.isMemberAsPerson.mockResolvedValue(true);
		const scope = PARTICIPATE.split(' ')
			.filter((token) => !token.startsWith('space:org.atgrp.members'))
			.join(' ');
		expect(await groupView(GROUP, ALICE, person(scope))).toMatchObject({
			member: true,
			askAccess: true
		});
		expect(mocks.confirmMembership).not.toHaveBeenCalled();
	});

	it('says it could not tell when the membership read fails', async () => {
		mocks.isMemberAsPerson.mockRejectedValue(new Error('host down'));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({ member: null });
	});

	it('is the same 404 for a private group the host keeps them out of', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.readMetaAsPerson.mockRejectedValue(new SpaceAccessDenied(META, '400 NotAuthorized'));
		await expect(groupView(GROUP, ALICE, person())).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
	});

	it("is a 503, not a 404, when the host's answer is unclear for a group they are in", async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.readMetaAsPerson.mockRejectedValue(new SpaceAccessDenied(META, '400 SpaceNotFound'));
		mocks.actorGroups.mockResolvedValue([
			{ did: GROUP, handle: 'knit.example', displayName: null }
		]);
		await expect(groupView(GROUP, ALICE, person())).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_UNCHECKED }
		});

		mocks.actorGroups.mockResolvedValue([]);
		await expect(groupView(GROUP, ALICE, person())).rejects.toMatchObject({ status: 404 });
	});

	it('asks for the permissions a sign-in lacks, and reads nothing with it', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE, person('atproto'))).toMatchObject({
			personal: null,
			member: null,
			askAccess: true
		});
		expect(mocks.readMetaAsPerson).not.toHaveBeenCalled();
	});

	it("reads nothing as the person for a group not at this site's host, nor for another's session", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.atGroupHost.mockReturnValue(false);
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({
			personal: null,
			askAccess: false
		});
		mocks.atGroupHost.mockReturnValue(true);
		expect(await groupView(GROUP, 'did:plc:bob', person())).toMatchObject({ personal: null });
		expect(mocks.readMetaAsPerson).not.toHaveBeenCalled();
	});
});

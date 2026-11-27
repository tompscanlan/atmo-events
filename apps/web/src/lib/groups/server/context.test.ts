import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { isHttpError } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
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
	linkAskedCurrentScope: vi.fn()
}));
vi.mock('./group', () => ({
	resolveGroup: mocks.resolveGroup,
	isDeclared: mocks.isDeclared,
	readGroupMeta: mocks.readGroupMeta,
	readLinkedMeta: mocks.readGroupMeta,
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
import {
	GROUP_NOT_FOUND,
	groupHome,
	groupHostSite,
	groupView,
	LINKED_READ_LIMIT_MS,
	requireGroupWriter,
	requireStoredLink
} from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
/** The scope the host grants an admin's session, and a member's. */
const ADMIN_SCOPE = [
	'atproto',
	`space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`,
	'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
	'blob?accept=image/*'
].join(' ');
const MEMBER_SCOPE = `atproto space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`;
const linkedSession = (scope = ADMIN_SCOPE, aud = 'https://host.example') => ({
	did: GROUP,
	getTokenInfo: vi.fn(async () => ({ scope, aud }))
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
});

describe('groupView for a visitor', () => {
	it('is the same 404 for an unknown actor and for an undeclared group', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		await expect(groupView(GROUP, null)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});

		mocks.resolveGroup.mockResolvedValueOnce(null);
		await expect(groupView('nobody.example', null)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
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

	it("gives a declared group's website, as cached, and its home at its handle's address", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([
				[
					GROUP,
					{
						name: 'Knitters',
						description: null,
						handle: 'knit.example',
						website: 'https://yarn.example/'
					}
				]
			])
		);
		expect(await groupView(GROUP, null)).toMatchObject({
			website: 'https://yarn.example/',
			home: 'https://knit.example/',
			// Its group host's own site, from the PDS its DID document names, not its address.
			hostSite: { url: 'https://host.example/', name: 'host.example' }
		});
		mocks.readCachedProfiles.mockResolvedValue(new Map());
		expect(await groupView(GROUP, null)).toMatchObject({ website: null });
	});

	it('gives no home to a group whose handle did not check out', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.resolveGroup.mockResolvedValue({ ...resolved, handle: null });
		expect((await groupView(GROUP, null)).home).toBeNull();
	});
});

describe('groupHome', () => {
	it("is the address of the group's handle, and nothing for an address that is not one", () => {
		expect(groupHome('knit.example')).toBe('https://knit.example/');
		expect(groupHome('Knit.Example')).toBe('https://knit.example/');
		expect(groupHome(null)).toBeNull();
		for (const handle of [
			'knit.example/evil',
			'evil.example#knit.example',
			'a@evil.example',
			'knit example'
		]) {
			expect(groupHome(handle), handle).toBeNull();
		}
	});
});

describe('groupHostSite', () => {
	it("is the origin of the group's PDS, named by its host, whatever path the PDS has", () => {
		expect(groupHostSite('https://groups.example')).toEqual({
			url: 'https://groups.example/',
			name: 'groups.example'
		});
		expect(groupHostSite('https://groups.example:8443/pds/')).toEqual({
			url: 'https://groups.example:8443/',
			name: 'groups.example:8443'
		});
	});

	it('is none for a PDS address that is not a web address', () => {
		for (const pds of ['', null, 'javascript:alert(1)', 'ftp://groups.example', 'groups.example']) {
			expect(groupHostSite(pds), String(pds)).toBeNull();
		}
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
				can: { post: true, list: true },
				reapprove: false
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
			can: { post: false, list: false },
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
		// Each name a refusal takes is read in xrpc.test.ts; one of each kind here.
		['the PDS', new XrpcError('com.atproto.space.getRecord', 403, 'ScopeMissingError')],
		['the space', new SpaceAccessDenied(META, '403 ScopeMissing')],
		// The credential it bought, refused at the read: not the session, so linking again won't help.
		['the space', new XrpcError('com.atproto.space.getRecord', 401, 'CredentialRevoked')]
	])(
		'shows the group without the link when its roles no longer allow reading it (%s: %s)',
		async (_from, refusal) => {
			mocks.readGroupMeta.mockRejectedValue(refusal);
			mocks.repoHasDeclaration.mockResolvedValue(true);
			mocks.isDeclared.mockResolvedValue(true);
			// Not an outage: the page says nothing of an unreachable host.
			expect(await groupView(GROUP, ALICE)).toMatchObject({
				linked: null,
				relink: false,
				hasLink: true,
				unreachable: false
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
			expect.objectContaining({ ...bareView, relink: false, unreachable: false })
		);
		expect(mocks.readCachedProfiles).not.toHaveBeenCalled();
	});

	it("shows what a visitor sees, and says so, when the group's PDS is down", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.readGroupMeta.mockRejectedValue(new XrpcError('com.atproto.space.getRecord', 502, null));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([[GROUP, { name: 'Knitters', description: 'Yarn', handle: 'knit.example' }]])
		);
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			name: 'Knitters',
			linked: null,
			relink: false,
			hasLink: true,
			unreachable: true
		});
		expect(mocks.isDeclared).toHaveBeenCalledWith(GROUP);
		expect(mocks.storeCachedProfile).not.toHaveBeenCalled();
		expect(mocks.syncDeclarationIndex).not.toHaveBeenCalled();
	});

	it('shows an undeclared group bare when its PDS is down, so it can still be unlinked', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.readGroupMeta.mockRejectedValue(new Error('fetch failed'));
		mocks.repoHasDeclaration.mockResolvedValue(true);
		mocks.isDeclared.mockResolvedValue(false);
		const view = await groupView(GROUP, ALICE).catch((e: unknown) => e);
		expect(isHttpError(view)).toBe(false);
		expect(view).toEqual(expect.objectContaining({ ...bareView, unreachable: true }));
	});

	it('waits on a link no longer than its limit, however slow the host', async () => {
		vi.useFakeTimers();
		try {
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			mocks.readGroupMeta.mockReturnValue(new Promise(() => {}));
			mocks.repoHasDeclaration.mockResolvedValue(true);
			mocks.isDeclared.mockResolvedValue(true);
			const view = groupView(GROUP, ALICE);
			await vi.advanceTimersByTimeAsync(LINKED_READ_LIMIT_MS - 1);
			expect(mocks.isDeclared).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(await view).toMatchObject({ linked: null, hasLink: true, unreachable: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('says nothing of an unreachable host when the link reads the group', async () => {
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE)).toMatchObject({ unreachable: false });
	});
});

describe('a link to a group no longer at the group host', () => {
	const atHost = ({ pds }: { pds: string }) => pds === 'https://host.example';

	beforeEach(() => {
		mocks.atGroupHost.mockImplementation(atHost);
		mocks.isDeclared.mockResolvedValue(true);
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(true);
	});

	it('is not read when the group moved to another host, and can only come off', async () => {
		mocks.resolveGroup.mockResolvedValue({ ...resolved, pds: 'https://elsewhere.example' });
		mocks.groupSession.mockResolvedValue(linkedSession());
		expect(await groupView(GROUP, ALICE)).toMatchObject({
			linked: null,
			relink: false,
			hasLink: true,
			atHost: false
		});
		expect(mocks.readGroupMeta).not.toHaveBeenCalled();
	});

	it('is not read, nor written through, when it was approved at another host', async () => {
		mocks.groupSession.mockResolvedValue(linkedSession(ADMIN_SCOPE, 'https://old-host.example'));
		expect(await groupView(GROUP, ALICE)).toMatchObject({ linked: null, hasLink: true });
		expect(mocks.readGroupMeta).not.toHaveBeenCalled();
		await expect(requireGroupWriter(GROUP, ALICE)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
	});

	it('is read and written through while both are at the group host', async () => {
		mocks.groupSession.mockResolvedValue(linkedSession());
		expect((await groupView(GROUP, ALICE)).linked).toMatchObject({ meta });
		expect(await requireGroupWriter(GROUP, ALICE)).toMatchObject({ did: GROUP });
	});
});

describe('requireGroupWriter', () => {
	it('is the same 404 without a linked session', async () => {
		const notFound = { status: 404, body: { message: GROUP_NOT_FOUND } };
		await expect(requireGroupWriter(GROUP, ALICE)).rejects.toMatchObject(notFound);
		await expect(requireGroupWriter(GROUP, null)).rejects.toMatchObject(notFound);
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

	it('is the same 404 with no link stored, or signed out', async () => {
		const notFound = { status: 404, body: { message: GROUP_NOT_FOUND } };
		mocks.hasGroupSession.mockResolvedValue(false);
		await expect(requireStoredLink(GROUP, ALICE)).rejects.toMatchObject(notFound);
		await expect(requireStoredLink(GROUP, null)).rejects.toMatchObject(notFound);
	});
});

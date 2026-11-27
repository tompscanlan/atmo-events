import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env, waitUntil } from 'cloudflare:workers';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { GROUP_SPACE_INDEX_SCOPE, MEMBERS_ONLY_SCOPES } from '../scopes';
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
	readMetaAsPerson: vi.fn(),
	isMemberAsPerson: vi.fn(),
	actorGroups: vi.fn(),
	confirmAdmitted: vi.fn(),
	hasConfirmation: vi.fn(),
	joinRequested: vi.fn()
}));
vi.mock('./group', () => ({
	resolveGroup: mocks.resolveGroup,
	isDeclared: mocks.isDeclared,
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
vi.mock('./person', () => ({
	personReader: () => ({}),
	readMetaAsPerson: mocks.readMetaAsPerson,
	isMemberAsPerson: mocks.isMemberAsPerson
}));
vi.mock('./host', () => ({ actorGroups: mocks.actorGroups }));
vi.mock('./confirmation', () => ({
	confirmAdmitted: mocks.confirmAdmitted,
	hasConfirmation: mocks.hasConfirmation,
	joinRequested: mocks.joinRequested
}));

import {
	GROUP_NOT_FOUND,
	GROUP_UNCHECKED,
	groupHome,
	groupHostSite,
	groupView,
	LINKED_READ_LIMIT_MS,
	requireGroupWriter,
	requireLinkedAbilities,
	requireStoredLink
} from './context';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
/** The scope the host grants an admin's session, and a member's. */
const ADMIN_SCOPE = [
	'atproto',
	`space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`,
	'repo?collection=community.lexicon.calendar.event',
	'blob?accept=image/*',
	...MEMBERS_ONLY_SCOPES.map((scope) => scope.replace('authority=self', `authority=${GROUP}`))
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
				can: { post: true },
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
			can: { post: false },
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

	it("offers to approve again a link from before atmo read the group's index of its spaces", async () => {
		mocks.readGroupMeta.mockResolvedValue(meta);
		mocks.repoHasDeclaration.mockResolvedValue(false);
		mocks.linkAskedCurrentScope.mockResolvedValue(false);
		const withoutIndex = ADMIN_SCOPE.split(' ')
			.filter((token) => token !== GROUP_SPACE_INDEX_SCOPE.replace('self', GROUP))
			.join(' ');
		expect(withoutIndex).not.toBe(ADMIN_SCOPE);
		mocks.groupSession.mockResolvedValue(linkedSession(withoutIndex));
		expect((await groupView(GROUP, ALICE)).linked).toMatchObject({
			can: { turnOnMembersOnly: true, membersOnly: true, readSpaceIndex: false },
			reapprove: true
		});
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

describe('requireLinkedAbilities', () => {
	it('says what the scope the host granted the link lets it do', async () => {
		mocks.groupSession.mockResolvedValue(linkedSession());
		const admin = await requireLinkedAbilities(GROUP, ALICE);
		expect(admin.writer).toMatchObject({ did: GROUP });
		expect(admin.can).toMatchObject({ turnOnMembersOnly: true, membersOnly: true });
		mocks.groupSession.mockResolvedValue(linkedSession(MEMBER_SCOPE));
		expect((await requireLinkedAbilities(GROUP, ALICE)).can).toMatchObject({
			turnOnMembersOnly: false,
			membersOnly: false,
			post: false
		});
	});

	it('holds nothing when the scope cannot be read, and is the same 404 without a link', async () => {
		mocks.groupSession.mockResolvedValue({
			did: GROUP,
			// The first read, for the session's host, is taken as at the host, so the second decides.
			getTokenInfo: vi
				.fn()
				.mockRejectedValueOnce(new Error('unreadable'))
				.mockRejectedValueOnce(new Error('unreadable'))
		});
		expect((await requireLinkedAbilities(GROUP, ALICE)).can).toMatchObject({
			turnOnMembersOnly: false,
			membersOnly: false
		});
		mocks.groupSession.mockResolvedValue(null);
		await expect(requireLinkedAbilities(GROUP, ALICE)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
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
		mocks.joinRequested.mockResolvedValue(false);
		mocks.hasConfirmation.mockResolvedValue(true);
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

	it('shows a private group to its member without a declaration, and writes nothing for the visit', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.readMetaAsPerson.mockResolvedValue({ ...personal, public: false });
		mocks.isMemberAsPerson.mockResolvedValue(true);
		const caller = person();
		expect(await groupView(GROUP, ALICE, caller)).toMatchObject({
			name: 'Knitters',
			personal: { public: false },
			member: true,
			confirmed: true
		});
		expect(mocks.isDeclared).not.toHaveBeenCalled();
		expect(waitUntil).not.toHaveBeenCalled();
		expect(mocks.confirmAdmitted).not.toHaveBeenCalled();
	});

	it("says when a member admitted some other way hasn't confirmed, and writes nothing for them", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.isMemberAsPerson.mockResolvedValue(true);
		mocks.hasConfirmation.mockResolvedValue(false);
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({
			member: true,
			confirmed: false
		});
		expect(mocks.joinRequested).toHaveBeenCalledWith(ALICE, GROUP);
		expect(waitUntil).not.toHaveBeenCalled();
		expect(mocks.confirmAdmitted).not.toHaveBeenCalled();
	});

	it('writes the confirmation on the first visit after a request made here was admitted', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.isMemberAsPerson.mockResolvedValue(true);
		mocks.joinRequested.mockResolvedValue(true);
		const caller = person();
		expect(await groupView(GROUP, ALICE, caller)).toMatchObject({ member: true, confirmed: true });
		expect(waitUntil).toHaveBeenCalledOnce();
		expect(mocks.confirmAdmitted).toHaveBeenCalledWith(caller, GROUP);
		expect(mocks.hasConfirmation).not.toHaveBeenCalled();
	});

	it('writes nothing for a request still waiting', async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.joinRequested.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({
			member: false,
			confirmed: null
		});
		expect(mocks.confirmAdmitted).not.toHaveBeenCalled();
	});

	it('writes no confirmation for a member whose sign-in cannot write it', async () => {
		mocks.isMemberAsPerson.mockResolvedValue(true);
		const scope = PARTICIPATE.split(' ')
			.filter((token) => !token.startsWith('space:org.atgrp.members'))
			.join(' ');
		mocks.joinRequested.mockResolvedValue(true);
		expect(await groupView(GROUP, ALICE, person(scope))).toMatchObject({
			member: true,
			confirmed: null,
			askAccess: true
		});
		expect(mocks.confirmAdmitted).not.toHaveBeenCalled();
	});

	it.each([
		[
			'the host lists them in it',
			[{ did: GROUP, handle: 'knit.example', displayName: null }],
			null
		],
		['the host did not answer', null, null],
		['the host lists them in other groups only', [], false]
	] as const)(
		'settles a members space their PDS could not open by the host’s list: %s',
		async (_why, listed, member) => {
			mocks.isDeclared.mockResolvedValue(true);
			mocks.isMemberAsPerson.mockRejectedValue(
				new SpaceAccessDenied(`at:space/${GROUP}/org.atgrp.members/self`, '400 SpaceNotFound')
			);
			if (listed) mocks.actorGroups.mockResolvedValue(listed);
			else mocks.actorGroups.mockRejectedValue(new Error('host down'));
			vi.spyOn(console, 'warn').mockImplementation(() => {});
			expect(await groupView(GROUP, ALICE, person())).toMatchObject({ member, personal: personal });
		}
	);

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

	it('is a 503, not a 404, for an unlisted group when the host fails to answer', async () => {
		mocks.isDeclared.mockResolvedValue(false);
		mocks.readMetaAsPerson.mockRejectedValue(
			new XrpcError('com.atproto.space.getRecord', 502, null)
		);
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(groupView(GROUP, ALICE, person())).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_UNCHECKED }
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

	it("reads and asks nothing as the person for a group not at this site's host, nor for another's session", async () => {
		mocks.isDeclared.mockResolvedValue(true);
		mocks.atGroupHost.mockReturnValue(false);
		expect(await groupView(GROUP, ALICE, person())).toMatchObject({
			personal: null,
			askAccess: false
		});
		// Even a sign-in without the group permissions is asked for none of them there.
		expect(await groupView(GROUP, ALICE, person('atproto'))).toMatchObject({ askAccess: false });
		mocks.atGroupHost.mockReturnValue(true);
		expect(await groupView(GROUP, 'did:plc:bob', person())).toMatchObject({ personal: null });
		expect(mocks.readMetaAsPerson).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { GroupEventRefused } from './server/group-events';
import { XrpcError } from './server/xrpc';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireGroupWriter: vi.fn(),
	requireStoredLink: vi.fn(),
	readGroupMeta: vi.fn(),
	listGroup: vi.fn(),
	unlistGroup: vi.fn(),
	notifyIndex: vi.fn(),
	unlinkGroup: vi.fn(),
	handle: vi.fn(),
	resolveGroup: vi.fn(),
	saveSettings: vi.fn(),
	finishSetup: vi.fn(),
	refuseMembersOnlyKey: vi.fn(),
	turnOnMembersOnly: vi.fn()
}));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: mocks.getRequestEvent
}));
vi.mock('./server/context', () => ({
	requireGroupWriter: mocks.requireGroupWriter,
	requireStoredLink: mocks.requireStoredLink
}));
vi.mock('./server/group', () => ({
	readGroupMeta: mocks.readGroupMeta,
	listGroup: mocks.listGroup,
	unlistGroup: mocks.unlistGroup,
	notifyIndex: mocks.notifyIndex,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./server/sign-in', () => ({ unlinkGroup: mocks.unlinkGroup }));
vi.mock('./server/settings', async (importActual) => ({
	parseGroupSettings: (await importActual<typeof import('./server/settings')>()).parseGroupSettings,
	saveGroupSettings: mocks.saveSettings
}));
vi.mock('./server/create', () => ({ finishSetup: mocks.finishSetup }));
/** Making groups here and the settings are tested in the build, and once without. */
const build = vi.hoisted(() => ({ create: true, settings: true }));
vi.mock('./build', async (importOriginal) => ({
	...(await importOriginal<typeof import('./build')>()),
	get CREATE_IN_THIS_BUILD() {
		return build.create;
	},
	get SETTINGS_IN_THIS_BUILD() {
		return build.settings;
	}
}));
vi.mock('./server/group-events', async (importActual) => ({
	...(await importActual<typeof import('./server/group-events')>()),
	refuseMembersOnlyKey: mocks.refuseMembersOnlyKey,
	turnOnMembersOnly: mocks.turnOnMembersOnly
}));

import {
	deleteGroupEvent,
	finishGroupSetup,
	putGroupEvent,
	saveGroupSettings,
	setGroupListed,
	turnOnMembersOnlyEvents,
	unlinkGroupSession,
	uploadGroupBlob
} from './group.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';

beforeEach(() => {
	vi.resetAllMocks();
	build.create = true;
	build.settings = true;
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE } });
	mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: mocks.handle });
	mocks.handle.mockImplementation(async () => Response.json({ uri: 'at://u', cid: 'c' }));
	mocks.refuseMembersOnlyKey.mockResolvedValue(undefined);
});

describe('group writes', () => {
	it("go out only on the caller's own linked session", async () => {
		mocks.requireGroupWriter.mockImplementation(() => error(404, 'Group not found'));
		await expect(putGroupEvent({ groupDid: GROUP, rkey: 'r', record: {} })).rejects.toMatchObject({
			status: 404
		});
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.handle).not.toHaveBeenCalled();
	});

	it("write an event to the group's own repo and tell the index", async () => {
		expect(await putGroupEvent({ groupDid: GROUP, rkey: 'r', record: { name: 'Meet' } })).toEqual({
			uri: 'at://u',
			cid: 'c'
		});
		const [pathname, init] = mocks.handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.putRecord');
		expect(JSON.parse(init.body)).toEqual({
			repo: GROUP,
			collection: 'community.lexicon.calendar.event',
			rkey: 'r',
			record: { name: 'Meet' }
		});
		expect(mocks.notifyIndex).toHaveBeenCalledWith('at://u');
	});

	it("check the group's calendar space for the key first, as the group", async () => {
		await putGroupEvent({ groupDid: GROUP, rkey: 'r', record: { name: 'Meet' } });
		expect(mocks.refuseMembersOnlyKey).toHaveBeenCalledWith(
			{ did: GROUP, handle: mocks.handle },
			'r'
		);
	});

	it.each([
		['members-only', 'a members-only event stays members-only'],
		['key-unchecked', "couldn't be checked"]
	] as const)(
		'refuse a public save the calendar space refuses (%s), writing nothing',
		async (reason, words) => {
			mocks.refuseMembersOnlyKey.mockRejectedValue(new GroupEventRefused(reason));
			await expect(
				putGroupEvent({ groupDid: GROUP, rkey: 'r', record: { name: 'Meet' } })
			).rejects.toMatchObject({ status: 409, body: { message: expect.stringContaining(words) } });
			expect(mocks.handle).not.toHaveBeenCalled();
			expect(mocks.notifyIndex).not.toHaveBeenCalled();
		}
	);

	it('delete an event from the group repo and tell the index', async () => {
		await deleteGroupEvent({ groupDid: GROUP, rkey: 'r' });
		const [pathname, init] = mocks.handle.mock.calls[0];
		expect(pathname).toBe('/xrpc/com.atproto.repo.deleteRecord');
		expect(JSON.parse(init.body)).toEqual({
			repo: GROUP,
			collection: 'community.lexicon.calendar.event',
			rkey: 'r'
		});
		expect(mocks.notifyIndex).toHaveBeenCalledWith(
			`at://${GROUP}/community.lexicon.calendar.event/r`
		);
	});

	it('report a refusal as a 403 with a reason, without the PDS wording', async () => {
		mocks.handle.mockImplementation(async () =>
			Response.json({ error: 'Forbidden', message: 'x' }, { status: 403 })
		);
		for (const write of [
			() => putGroupEvent({ groupDid: GROUP, rkey: 'r', record: {} }),
			() => deleteGroupEvent({ groupDid: GROUP, rkey: 'r' }),
			() => uploadGroupBlob({ groupDid: GROUP, bytes: [1], mimeType: 'image/png' })
		]) {
			await expect(write()).rejects.toMatchObject({
				status: 403,
				body: { message: 'Your role in this group no longer allows that.' }
			});
		}
		expect(mocks.notifyIndex).not.toHaveBeenCalled();
	});

	it('report a link the host no longer takes as a 403 that says to link again', async () => {
		mocks.handle.mockResolvedValue(Response.json({ error: 'invalid_token' }, { status: 401 }));
		await expect(putGroupEvent({ groupDid: GROUP, rkey: 'r', record: {} })).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('Link it again') }
		});
		mocks.handle.mockRejectedValue(new TokenRefreshError(GROUP, 'invalid_grant'));
		await expect(deleteGroupEvent({ groupDid: GROUP, rkey: 'r' })).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('Link it again') }
		});
	});

	it('report an outage as a 502, without the PDS wording', async () => {
		mocks.handle.mockImplementation(async () =>
			Response.json({ error: 'InternalServerError', message: 'x' }, { status: 500 })
		);
		await expect(putGroupEvent({ groupDid: GROUP, rkey: 'r', record: {} })).rejects.toMatchObject({
			status: 502,
			body: { message: 'Saving the event failed' }
		});
		await expect(
			uploadGroupBlob({ groupDid: GROUP, bytes: [1], mimeType: 'image/png' })
		).rejects.toMatchObject({ status: 502, body: { message: 'Upload failed' } });
		expect(mocks.notifyIndex).not.toHaveBeenCalled();
	});
});

describe('listing', () => {
	it('lists a public group and unlists any', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
		await setGroupListed({ groupDid: GROUP, listed: true });
		expect(mocks.listGroup).toHaveBeenCalledWith(mocks.handle, GROUP);
		await setGroupListed({ groupDid: GROUP, listed: false });
		expect(mocks.unlistGroup).toHaveBeenCalledWith(mocks.handle, GROUP);
	});

	it('refuses to list a private group, and says why', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: false });
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 409,
			body: { message: expect.stringContaining('this one is private') }
		});
		expect(mocks.listGroup).not.toHaveBeenCalled();
	});

	it('says the same when the group host refuses the declaration, the group having turned private since it was read', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
		mocks.listGroup.mockRejectedValue(
			new XrpcError('com.atproto.repo.putRecord', 400, 'InvalidRequest')
		);
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 409,
			body: { message: expect.stringContaining('this one is private') }
		});
	});

	it.each([
		[
			'the meta space refuses its credential',
			new SpaceAccessDenied('at:space/x', '403 ScopeMissing')
		],
		[
			'the host says the scope is missing',
			new XrpcError('com.atproto.repo.putRecord', 403, 'ScopeMissing')
		]
	])(
		'is a 403 that says the role no longer allows it, not a 500, when %s',
		async (_why, refusal) => {
			const noRole = {
				status: 403,
				body: { message: 'Your role in this group no longer allows that.' }
			};
			mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
			mocks.listGroup.mockRejectedValue(refusal);
			mocks.unlistGroup.mockRejectedValue(refusal);
			for (const listed of [true, false]) {
				await expect(setGroupListed({ groupDid: GROUP, listed })).rejects.toMatchObject(noRole);
			}
			mocks.readGroupMeta.mockRejectedValue(refusal);
			await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject(noRole);
		}
	);

	it('passes on any other failure', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
		const outage = new XrpcError('com.atproto.repo.putRecord', 502, null);
		mocks.listGroup.mockRejectedValue(outage);
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toBe(outage);
		const unlisted = new XrpcError('com.atproto.repo.deleteRecord', 400, 'InvalidRequest');
		mocks.unlistGroup.mockRejectedValue(unlisted);
		await expect(setGroupListed({ groupDid: GROUP, listed: false })).rejects.toBe(unlisted);
	});
});

describe('unlink', () => {
	it("forgets only the caller's own link, without needing it to work", async () => {
		mocks.requireStoredLink.mockResolvedValue(ALICE);
		await unlinkGroupSession({ groupDid: GROUP });
		expect(mocks.requireStoredLink).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.requireGroupWriter).not.toHaveBeenCalled();
		expect(mocks.unlinkGroup).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

describe('settings', () => {
	const form = {
		name: 'Night Riders',
		description: '',
		website: 'https://riders.example',
		joinPolicy: 'open',
		public: true,
		listed: false
	};

	it("is groups-off's 404 in a build without the settings page, before looking for a link", async () => {
		build.settings = false;
		await expect(
			saveGroupSettings({ groupDid: GROUP, shownPublic: true, settings: form })
		).rejects.toMatchObject({ status: 404, body: { message: 'Not Found' } });
		expect(mocks.requireGroupWriter).not.toHaveBeenCalled();
		expect(mocks.saveSettings).not.toHaveBeenCalled();
	});

	it("saves them as the group, on the caller's own link, keeping what the form showed", async () => {
		mocks.resolveGroup.mockResolvedValue({
			did: GROUP,
			handle: 'riders.example',
			pds: 'https://h'
		});
		expect(
			await saveGroupSettings({ groupDid: GROUP, shownPublic: false, settings: form })
		).toEqual({
			ok: true
		});
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.saveSettings).toHaveBeenCalledWith(
			{ did: GROUP, handle: mocks.handle },
			{ did: GROUP, handle: 'riders.example', pds: 'https://h' },
			{
				name: 'Night Riders',
				description: null,
				website: 'https://riders.example/',
				joinPolicy: 'open',
				public: true,
				listed: false
			},
			false
		);
	});

	it('says what is wrong with a form it cannot take, and writes nothing', async () => {
		await expect(
			saveGroupSettings({ groupDid: GROUP, shownPublic: true, settings: { ...form, name: ' ' } })
		).rejects.toMatchObject({ status: 400, body: { message: expect.stringContaining('name') } });
		expect(mocks.saveSettings).not.toHaveBeenCalled();
	});

	it.each([
		[new XrpcError('com.atproto.space.updateSpace', 403, 'NotAuthorized'), 403, 'role'],
		[new XrpcError('com.atproto.space.getDelegationToken', 401, 'invalid_token'), 403, 'Link'],
		[new XrpcError('com.atproto.space.putRecord', 400, 'InvalidRequest'), 400, 'did not take']
	])('answers %s with a %i that says why', async (refusal, status, words) => {
		mocks.saveSettings.mockRejectedValue(refusal);
		await expect(
			saveGroupSettings({ groupDid: GROUP, shownPublic: true, settings: form })
		).rejects.toMatchObject({ status, body: { message: expect.stringContaining(words) } });
	});
});

describe('finishing a group made here', () => {
	it("finishes it as the group, on the caller's own link", async () => {
		await finishGroupSetup({ groupDid: GROUP });
		expect(mocks.finishSetup).toHaveBeenCalledWith({ did: GROUP, handle: mocks.handle }, ALICE);
	});

	it('answers a refusal with a 403 that says why', async () => {
		mocks.finishSetup.mockRejectedValue(
			new XrpcError('com.atproto.repo.deleteRecord', 403, 'Forbidden')
		);
		await expect(finishGroupSetup({ groupDid: GROUP })).rejects.toMatchObject({
			status: 403,
			body: { message: 'Your role in this group no longer allows that.' }
		});
	});

	it("is groups-off's 404 in a build without making groups here, before looking for a link", async () => {
		build.create = false;
		await expect(finishGroupSetup({ groupDid: GROUP })).rejects.toMatchObject({
			status: 404,
			body: { message: 'Not Found' }
		});
		expect(mocks.requireGroupWriter).not.toHaveBeenCalled();
		expect(mocks.finishSetup).not.toHaveBeenCalled();
	});
});

describe('turning members-only events on', () => {
	it("does it as the group, on the caller's own link", async () => {
		mocks.turnOnMembersOnly.mockResolvedValue({ state: 'ready', posters: [], space: 's' });
		expect(await turnOnMembersOnlyEvents({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.turnOnMembersOnly).toHaveBeenCalledWith({ did: GROUP, handle: mocks.handle }, []);
	});

	it('says plainly why when the group has a calendar atmo may not post to, and makes none', async () => {
		mocks.turnOnMembersOnly.mockRejectedValue(new GroupEventRefused('calendar-space-not-granted'));
		await expect(turnOnMembersOnlyEvents({ groupDid: GROUP })).rejects.toMatchObject({
			status: 409,
			body: {
				message:
					'This group already has a calendar for its members, but its settings let no role post events to it from atmo, so atmo made no second one. An admin can allow it at the group host.'
			}
		});
	});
});

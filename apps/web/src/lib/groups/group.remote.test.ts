import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { GroupEventRefused } from './server/group-events';
import { XrpcError } from './server/xrpc';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireGroupWriter: vi.fn(),
	requireLinkedAbilities: vi.fn(),
	requireStoredLink: vi.fn(),
	notifyIndex: vi.fn(),
	unlinkGroup: vi.fn(),
	handle: vi.fn(),
	resolveGroup: vi.fn(),
	saveSettings: vi.fn(),
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
	requireLinkedAbilities: mocks.requireLinkedAbilities,
	requireStoredLink: mocks.requireStoredLink
}));
vi.mock('./server/group', () => ({
	notifyIndex: mocks.notifyIndex,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./server/sign-in', () => ({ unlinkGroup: mocks.unlinkGroup }));
vi.mock('./server/settings', async (importActual) => ({
	parseGroupSettings: (await importActual<typeof import('./server/settings')>()).parseGroupSettings,
	saveGroupSettings: mocks.saveSettings
}));
/** The settings are tested in the build, and once without. */
const build = vi.hoisted(() => ({ settings: true }));
vi.mock('./build', async (importOriginal) => ({
	...(await importOriginal<typeof import('./build')>()),
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
	putGroupEvent,
	saveGroupSettings,
	turnOnMembersOnlyEvents,
	unlinkGroupSession,
	uploadGroupBlob
} from './group.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';

beforeEach(() => {
	vi.resetAllMocks();
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

	it.each([['members-only', 'a members-only event stays members-only']] as const)(
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
		public: true
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
				public: true
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

describe('turning members-only events on', () => {
	beforeEach(() => {
		mocks.requireLinkedAbilities.mockResolvedValue({
			writer: { did: GROUP, handle: mocks.handle },
			can: { turnOnMembersOnly: true, membersOnly: false }
		});
	});

	it("does it as the group, on the caller's own link", async () => {
		mocks.turnOnMembersOnly.mockResolvedValue({ state: 'ready', posters: [], space: 's' });
		expect(await turnOnMembersOnlyEvents({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.requireLinkedAbilities).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.turnOnMembersOnly).toHaveBeenCalledWith({ did: GROUP, handle: mocks.handle }, []);
	});

	it.each([
		['may post there, but not make the calendar', { turnOnMembersOnly: false, membersOnly: true }]
	])('is refused, with nothing read or chosen, for a link that %s', async (_, can) => {
		mocks.requireLinkedAbilities.mockResolvedValue({
			writer: { did: GROUP, handle: mocks.handle },
			can
		});
		await expect(turnOnMembersOnlyEvents({ groupDid: GROUP })).rejects.toMatchObject({
			status: 403,
			body: { message: "Your role in this group doesn't let you turn on members-only events." }
		});
		expect(mocks.turnOnMembersOnly).not.toHaveBeenCalled();
		expect(mocks.handle).not.toHaveBeenCalled();
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

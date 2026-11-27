import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';
import { TokenRefreshError } from '@atcute/oauth-node-client';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
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
	handle: vi.fn()
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
	notifyIndex: mocks.notifyIndex
}));
vi.mock('./server/sign-in', () => ({ unlinkGroup: mocks.unlinkGroup }));

import {
	deleteGroupEvent,
	putGroupEvent,
	setGroupListed,
	unlinkGroupSession,
	uploadGroupBlob
} from './group.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE } });
	mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: mocks.handle });
	mocks.handle.mockImplementation(async () => Response.json({ uri: 'at://u', cid: 'c' }));
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

	it('says to make it public at the group host', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: false });
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 409,
			body: { message: expect.stringContaining('Make it public at the group host first.') }
		});
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

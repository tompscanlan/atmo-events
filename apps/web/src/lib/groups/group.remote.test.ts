import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';
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
	unlinkGroupSession
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
		expect(mocks.handle.mock.calls[0][0]).toBe('/xrpc/com.atproto.repo.deleteRecord');
		expect(mocks.notifyIndex).toHaveBeenCalledWith(
			`at://${GROUP}/community.lexicon.calendar.event/r`
		);
	});

	it('report a refused write without the PDS wording', async () => {
		mocks.handle.mockResolvedValue(
			Response.json({ error: 'Forbidden', message: 'x' }, { status: 403 })
		);
		await expect(putGroupEvent({ groupDid: GROUP, rkey: 'r', record: {} })).rejects.toMatchObject({
			status: 502,
			body: { message: 'Saving the event failed' }
		});
		expect(mocks.notifyIndex).not.toHaveBeenCalled();
	});
});

describe('listing', () => {
	it('refuses to list a private group', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: false });
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 409
		});
		expect(mocks.listGroup).not.toHaveBeenCalled();
	});

	it('lists a public group and unlists any', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
		await setGroupListed({ groupDid: GROUP, listed: true });
		expect(mocks.listGroup).toHaveBeenCalledWith(mocks.handle, GROUP);
		await setGroupListed({ groupDid: GROUP, listed: false });
		expect(mocks.unlistGroup).toHaveBeenCalledWith(mocks.handle, GROUP);
	});

	it('says why a private group cannot be listed', async () => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: false });
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 409,
			body: { message: expect.stringContaining('this one is private') }
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
		],
		[
			'the host says the role may no longer',
			new XrpcError('com.atproto.repo.putRecord', 403, 'Forbidden')
		]
	])('is a 403, not a 500, when %s', async (_why, refusal) => {
		mocks.readGroupMeta.mockResolvedValue({ profile: null, public: true });
		mocks.listGroup.mockRejectedValue(refusal);
		mocks.unlistGroup.mockRejectedValue(refusal);
		for (const listed of [true, false]) {
			await expect(setGroupListed({ groupDid: GROUP, listed })).rejects.toMatchObject({
				status: 403
			});
		}
		mocks.readGroupMeta.mockRejectedValue(refusal);
		await expect(setGroupListed({ groupDid: GROUP, listed: true })).rejects.toMatchObject({
			status: 403
		});
	});

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

	it('is the 404 when the caller has no link stored', async () => {
		mocks.requireStoredLink.mockImplementation(() => error(404, 'Group not found'));
		await expect(unlinkGroupSession({ groupDid: GROUP })).rejects.toMatchObject({ status: 404 });
		expect(mocks.unlinkGroup).not.toHaveBeenCalled();
	});
});

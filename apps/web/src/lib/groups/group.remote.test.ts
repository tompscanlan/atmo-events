import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireGroupWriter: vi.fn(),
	readGroupMeta: vi.fn(),
	listGroup: vi.fn(),
	unlistGroup: vi.fn(),
	notifyIndex: vi.fn(),
	unlinkGroup: vi.fn(),
	putGroupEvent: vi.fn(),
	deleteGroupEvent: vi.fn(),
	handle: vi.fn()
}));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: mocks.getRequestEvent
}));
vi.mock('./server/context', () => ({ requireGroupWriter: mocks.requireGroupWriter }));
vi.mock('./server/group', () => ({
	readGroupMeta: mocks.readGroupMeta,
	listGroup: mocks.listGroup,
	unlistGroup: mocks.unlistGroup,
	notifyIndex: mocks.notifyIndex
}));
vi.mock('./server/sign-in', () => ({ unlinkGroup: mocks.unlinkGroup }));
vi.mock('./server/group-events', async (original) => ({
	...(await original()),
	putGroupEvent: mocks.putGroupEvent,
	deleteGroupEvent: mocks.deleteGroupEvent
}));

import { GroupEventRefused } from './server/group-events';
import {
	removeGroupEvent,
	saveGroupEvent,
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

describe('group event writes', () => {
	const writer = () => ({ did: GROUP, handle: mocks.handle });

	it("go out only on the caller's own linked session", async () => {
		mocks.requireGroupWriter.mockImplementation(() => error(404, 'Group not found'));
		await expect(
			saveGroupEvent({ groupDid: GROUP, rkey: 'r', record: {}, placement: 'everyone' })
		).rejects.toMatchObject({ status: 404 });
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.putGroupEvent).not.toHaveBeenCalled();
	});

	it('go where the placement says, on that session', async () => {
		mocks.putGroupEvent.mockResolvedValue({ uri: 'at://u', cid: 'c' });
		mocks.deleteGroupEvent.mockResolvedValue(undefined);
		const input = { rkey: 'r', record: { name: 'Meet' }, placement: 'members' } as const;
		expect(await saveGroupEvent({ groupDid: GROUP, ...input })).toEqual({
			uri: 'at://u',
			cid: 'c'
		});
		expect(mocks.putGroupEvent).toHaveBeenCalledWith(writer(), input);

		await removeGroupEvent({ groupDid: GROUP, rkey: 'r', placement: 'everyone' });
		expect(mocks.deleteGroupEvent).toHaveBeenCalledWith(writer(), {
			rkey: 'r',
			placement: 'everyone'
		});
	});

	it('pass a refusal on in its own words, as a conflict', async () => {
		const refused = new GroupEventRefused('moved');
		mocks.putGroupEvent.mockRejectedValue(refused);
		await expect(
			saveGroupEvent({ groupDid: GROUP, rkey: 'r', record: {}, placement: 'everyone' })
		).rejects.toMatchObject({ status: 409, body: { message: refused.message } });
	});

	it("report any other failure without the PDS's wording", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.deleteGroupEvent.mockRejectedValue(new Error('the PDS said something'));
		const failed = await removeGroupEvent({
			groupDid: GROUP,
			rkey: 'r',
			placement: 'members'
		}).catch((e) => e);
		expect(failed).toMatchObject({ status: 502 });
		expect(failed.body.message).not.toContain('the PDS said');
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
});

describe('unlink', () => {
	it("forgets only the caller's own link", async () => {
		await unlinkGroupSession({ groupDid: GROUP });
		expect(mocks.unlinkGroup).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

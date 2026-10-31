import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	requireGroupWriter: vi.fn(),
	readGroupMeta: vi.fn(),
	listGroup: vi.fn(),
	unlistGroup: vi.fn(),
	unlinkGroup: vi.fn(),
	putGroupEvent: vi.fn(),
	deleteGroupEvent: vi.fn()
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
	unlistGroup: mocks.unlistGroup
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
const writer = { did: GROUP, handle: vi.fn() };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE } });
	mocks.requireGroupWriter.mockResolvedValue(writer);
});

describe('group event writes', () => {
	const at = { rkey: 'r', placement: 'everyone' } as const;
	const save = { groupDid: GROUP, ...at, record: {} };

	it("go out only on the caller's own linked session", async () => {
		mocks.requireGroupWriter.mockImplementation(() => error(404, 'Group not found'));
		await expect(saveGroupEvent(save)).rejects.toMatchObject({ status: 404 });
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.putGroupEvent).not.toHaveBeenCalled();
	});

	it('go where the placement says, on that session', async () => {
		const saved = { uri: 'at://u', cid: 'c' };
		mocks.putGroupEvent.mockResolvedValue(saved);
		const input = { rkey: 'r', record: { name: 'Meet' }, placement: 'members' } as const;
		expect(await saveGroupEvent({ groupDid: GROUP, ...input })).toEqual(saved);
		expect(mocks.putGroupEvent).toHaveBeenCalledWith(writer, input);

		mocks.deleteGroupEvent.mockResolvedValue(undefined);
		await removeGroupEvent({ groupDid: GROUP, ...at });
		expect(mocks.deleteGroupEvent).toHaveBeenCalledWith(writer, at);
	});

	it('pass a refusal on in its own words, as a conflict', async () => {
		const refused = new GroupEventRefused('moved');
		mocks.putGroupEvent.mockRejectedValue(refused);
		await expect(saveGroupEvent(save)).rejects.toMatchObject({
			status: 409,
			body: { message: refused.message }
		});
	});

	it("report any other failure without the PDS's wording", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.deleteGroupEvent.mockRejectedValue(new Error('the PDS said something'));
		const failed = await removeGroupEvent({ groupDid: GROUP, ...at }).catch((e) => e);
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
		expect(mocks.listGroup).toHaveBeenCalledWith(writer.handle, GROUP);
		await setGroupListed({ groupDid: GROUP, listed: false });
		expect(mocks.unlistGroup).toHaveBeenCalledWith(writer.handle, GROUP);
	});
});

describe('unlink', () => {
	it("forgets only the caller's own link", async () => {
		await unlinkGroupSession({ groupDid: GROUP });
		expect(mocks.unlinkGroup).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

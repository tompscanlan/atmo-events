import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	callerSession: vi.fn(),
	requireGroupWriter: vi.fn(),
	resolveGroup: vi.fn(),
	requestJoin: vi.fn(),
	admitMember: vi.fn(),
	removeMember: vi.fn()
}));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: mocks.getRequestEvent
}));
vi.mock('./server/caller', () => ({ callerSession: mocks.callerSession }));
vi.mock('./server/context', () => ({ requireGroupWriter: mocks.requireGroupWriter }));
vi.mock('./server/group', () => ({ resolveGroup: mocks.resolveGroup }));
vi.mock('./server/host', async (importActual) => ({
	...(await importActual<typeof import('./server/host')>()),
	requestJoin: mocks.requestJoin,
	admitMember: mocks.admitMember,
	removeMember: mocks.removeMember
}));

import { GroupActionError } from './server/host';
import { addMember, joinGroup, remove } from './members.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const caller = { did: ALICE, scope: '', handle: vi.fn() };
const writer = { did: GROUP, handle: vi.fn() };

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE, session: {} } });
	mocks.callerSession.mockResolvedValue(caller);
	mocks.requireGroupWriter.mockResolvedValue(writer);
});

describe("a person's own acts", () => {
	it('need a signed-in session', async () => {
		mocks.callerSession.mockResolvedValue(null);
		await expect(joinGroup({ groupDid: GROUP })).rejects.toMatchObject({ status: 401 });
		expect(mocks.requestJoin).not.toHaveBeenCalled();
	});

	it("go out on the caller's own session, and say what the host decided", async () => {
		mocks.requestJoin.mockResolvedValue('pending');
		expect(await joinGroup({ groupDid: GROUP, message: '  hello ' })).toEqual({
			outcome: 'pending'
		});
		expect(mocks.requestJoin).toHaveBeenCalledWith(caller, GROUP, 'hello');
	});

	it("pass on the host's refusal in its own words, as a 409", async () => {
		mocks.requestJoin.mockRejectedValue(new GroupActionError('This group is invite-only.'));
		await expect(joinGroup({ groupDid: GROUP })).rejects.toMatchObject({
			status: 409,
			body: { message: 'This group is invite-only.' }
		});
	});
});

describe("an admin's acts", () => {
	it("go out only on the caller's own linked session", async () => {
		mocks.requireGroupWriter.mockImplementation(() => error(404, 'Group not found'));
		await expect(remove({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({ status: 404 });
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.removeMember).not.toHaveBeenCalled();
	});

	it('add someone by handle, resolved to their DID', async () => {
		mocks.resolveGroup.mockResolvedValue({ did: BOB, handle: 'bob.example' });
		await addMember({ groupDid: GROUP, actor: '@bob.example', role: 'member' });
		expect(mocks.resolveGroup).toHaveBeenCalledWith('bob.example');
		expect(mocks.admitMember).toHaveBeenCalledWith(writer, BOB, 'member');
	});

	it('refuse a handle that does not resolve', async () => {
		mocks.resolveGroup.mockResolvedValue(null);
		await expect(
			addMember({ groupDid: GROUP, actor: 'nobody.example', role: 'member' })
		).rejects.toMatchObject({ status: 404 });
		expect(mocks.admitMember).not.toHaveBeenCalled();
	});
});

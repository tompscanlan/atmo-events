import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GroupActionRefused } from './server/host';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	callerSession: vi.fn(),
	requestJoin: vi.fn(),
	cancelJoinRequest: vi.fn(),
	leaveGroup: vi.fn(),
	confirmMembership: vi.fn(),
	writeConfirmation: vi.fn(),
	rememberJoinRequest: vi.fn(),
	forgetJoinRequest: vi.fn(),
	isMemberAsPerson: vi.fn(),
	resolveGroup: vi.fn()
}));
vi.mock('./server/group', () => ({
	resolveGroup: mocks.resolveGroup,
	atGroupHost: ({ pds }: { pds: string }) => pds === 'https://host.example'
}));
vi.mock('./server/confirmation', () => ({
	confirmMembership: mocks.confirmMembership,
	writeConfirmation: mocks.writeConfirmation,
	rememberJoinRequest: mocks.rememberJoinRequest,
	forgetJoinRequest: mocks.forgetJoinRequest
}));
vi.mock('./server/person', () => ({
	personReader: () => ({}),
	isMemberAsPerson: mocks.isMemberAsPerson
}));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: mocks.getRequestEvent
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('./server/context', () => ({
	GROUP_NOT_FOUND: 'Group not found'
}));
vi.mock('./server/host', async (importActual) => ({
	GroupActionRefused: (await importActual<typeof import('./server/host')>()).GroupActionRefused,
	requestJoin: mocks.requestJoin,
	cancelJoinRequest: mocks.cancelJoinRequest,
	leaveGroup: mocks.leaveGroup
}));

import { cancelJoin, confirmMember, joinGroup, leave } from './members.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const caller = { did: ALICE, scope: 'atproto', handle: vi.fn() };

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE, session: {} } });
	mocks.callerSession.mockResolvedValue(caller);
	mocks.rememberJoinRequest.mockResolvedValue(undefined);
	mocks.resolveGroup.mockResolvedValue({ did: GROUP, handle: null, pds: 'https://host.example' });
});

describe("a person's own membership", () => {
	it('joins as the person, with the message trimmed, and says how it went', async () => {
		mocks.requestJoin.mockResolvedValue('pending');
		expect(await joinGroup({ groupDid: GROUP, message: '  I knit.  ' })).toEqual({
			outcome: 'pending'
		});
		expect(mocks.requestJoin).toHaveBeenCalledWith(caller, GROUP, 'I knit.');

		mocks.requestJoin.mockResolvedValue('joined');
		expect(await joinGroup({ groupDid: GROUP, message: '   ' })).toEqual({ outcome: 'joined' });
		expect(mocks.requestJoin).toHaveBeenLastCalledWith(caller, GROUP, null);
	});

	it('cancels a request and leaves, as the person, forgetting any request made here', async () => {
		expect(await cancelJoin({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.cancelJoinRequest).toHaveBeenCalledWith(caller, GROUP);
		expect(await leave({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.leaveGroup).toHaveBeenCalledWith(caller, GROUP);
		expect(mocks.forgetJoinRequest).toHaveBeenCalledTimes(2);
		expect(mocks.forgetJoinRequest).toHaveBeenCalledWith(ALICE, GROUP);
	});

	it('writes the confirmation when they join an open group, since joining is their act', async () => {
		mocks.requestJoin.mockResolvedValue('joined');
		await joinGroup({ groupDid: GROUP });
		expect(mocks.confirmMembership).toHaveBeenCalledWith(caller, GROUP);
		expect(mocks.rememberJoinRequest).not.toHaveBeenCalled();
	});

	it('notes a request that waits, for the first visit after they are admitted, and writes nothing yet', async () => {
		mocks.requestJoin.mockResolvedValue('pending');
		await joinGroup({ groupDid: GROUP });
		expect(mocks.rememberJoinRequest).toHaveBeenCalledWith(ALICE, GROUP);
		expect(mocks.confirmMembership).not.toHaveBeenCalled();
	});

	it('writes nothing when the host refuses the join', async () => {
		mocks.requestJoin.mockRejectedValue(new GroupActionRefused('join-closed'));
		await expect(joinGroup({ groupDid: GROUP })).rejects.toMatchObject({ status: 409 });
		expect(mocks.confirmMembership).not.toHaveBeenCalled();
		expect(mocks.rememberJoinRequest).not.toHaveBeenCalled();
	});

	it('confirms a membership on request, only once the host counts them a member', async () => {
		mocks.isMemberAsPerson.mockResolvedValue(true);
		mocks.writeConfirmation.mockResolvedValue('written');
		expect(await confirmMember({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.writeConfirmation).toHaveBeenCalledWith(caller, GROUP);

		mocks.writeConfirmation.mockClear();
		mocks.isMemberAsPerson.mockResolvedValue(false);
		await expect(confirmMember({ groupDid: GROUP })).rejects.toMatchObject({ status: 409 });
		expect(mocks.writeConfirmation).not.toHaveBeenCalled();
	});

	it('does nothing in a group at another host, its confirmation included: the same 404', async () => {
		mocks.resolveGroup.mockResolvedValue({
			did: GROUP,
			handle: null,
			pds: 'https://elsewhere.example'
		});
		for (const act of [
			() => joinGroup({ groupDid: GROUP }),
			() => cancelJoin({ groupDid: GROUP }),
			() => leave({ groupDid: GROUP }),
			() => confirmMember({ groupDid: GROUP })
		]) {
			await expect(act()).rejects.toMatchObject({
				status: 404,
				body: { message: 'Group not found' }
			});
		}
		mocks.resolveGroup.mockResolvedValue(null);
		await expect(leave({ groupDid: GROUP })).rejects.toMatchObject({ status: 404 });
		for (const touched of [
			mocks.requestJoin,
			mocks.cancelJoinRequest,
			mocks.leaveGroup,
			mocks.writeConfirmation,
			mocks.confirmMembership,
			mocks.forgetJoinRequest,
			mocks.rememberJoinRequest
		]) {
			expect(touched).not.toHaveBeenCalled();
		}
	});

	it('says a sign-in that cannot write the confirmation needs the permission', async () => {
		mocks.isMemberAsPerson.mockResolvedValue(true);
		mocks.writeConfirmation.mockResolvedValue('skipped');
		await expect(confirmMember({ groupDid: GROUP })).rejects.toMatchObject({ status: 403 });
	});

	it.each([
		['join-closed', 409, 'invitation only'],
		['group-not-found', 404, 'Group not found'],
		['last-admin', 409, "You're the group's only admin"],
		['no-permission', 403, 'Allow atmo to act for you in groups']
	] as const)(
		'says why in plain words when the host refuses: %s',
		async (reason, status, words) => {
			mocks.leaveGroup.mockRejectedValue(new GroupActionRefused(reason));
			await expect(leave({ groupDid: GROUP })).rejects.toMatchObject({
				status,
				body: { message: expect.stringContaining(words) }
			});
		}
	);

	it('answers any other failure with a 502 that says nothing of what the host said', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.requestJoin.mockRejectedValue(new Error('the host said something private'));
		await expect(joinGroup({ groupDid: GROUP })).rejects.toMatchObject({
			status: 502,
			body: { message: 'The group host could not be reached. Try again shortly.' }
		});
	});

	it('needs someone signed in', async () => {
		mocks.callerSession.mockResolvedValue(null);
		await expect(joinGroup({ groupDid: GROUP })).rejects.toMatchObject({ status: 401 });
		expect(mocks.requestJoin).not.toHaveBeenCalled();
	});

	it('is a 404 with groups off, before reading the session', async () => {
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		for (const run of [
			() => joinGroup({ groupDid: GROUP }),
			() => cancelJoin({ groupDid: GROUP }),
			() => leave({ groupDid: GROUP }),
			() => confirmMember({ groupDid: GROUP })
		]) {
			await expect(run()).rejects.toMatchObject({ status: 404 });
		}
		expect(mocks.callerSession).not.toHaveBeenCalled();
	});
});

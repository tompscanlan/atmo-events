import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { GroupActionRefused } from './server/host';
import { RosterRefused } from './server/roster';
import { XrpcError } from './server/xrpc';

const mocks = vi.hoisted(() => ({
	getRequestEvent: vi.fn(),
	callerSession: vi.fn(),
	requestJoin: vi.fn(),
	cancelJoinRequest: vi.fn(),
	leaveGroup: vi.fn(),
	requireGroupWriter: vi.fn(),
	admitMember: vi.fn(),
	denyJoinRequest: vi.fn(),
	setMemberAdmin: vi.fn(),
	removeMember: vi.fn()
}));
vi.mock('$app/server', () => ({
	command: (_schema: unknown, handler: unknown) =>
		Object.assign(handler as object, { __: { type: 'command' } }),
	getRequestEvent: mocks.getRequestEvent
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('./server/context', () => ({
	GROUP_NOT_FOUND: 'Group not found',
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('./server/roster', async (importActual) => ({
	RosterRefused: (await importActual<typeof import('./server/roster')>()).RosterRefused,
	admitMember: mocks.admitMember,
	denyJoinRequest: mocks.denyJoinRequest,
	setMemberAdmin: mocks.setMemberAdmin,
	removeMember: mocks.removeMember
}));
vi.mock('./server/host', async (importActual) => ({
	GroupActionRefused: (await importActual<typeof import('./server/host')>()).GroupActionRefused,
	requestJoin: mocks.requestJoin,
	cancelJoinRequest: mocks.cancelJoinRequest,
	leaveGroup: mocks.leaveGroup
}));

import {
	approveRequest,
	cancelJoin,
	changeRole,
	denyRequest,
	joinGroup,
	leave,
	removeFromGroup
} from './members.remote';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const caller = { did: ALICE, scope: 'atproto', handle: vi.fn() };
const writer = { did: GROUP, handle: vi.fn() };

beforeEach(() => {
	vi.resetAllMocks();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.getRequestEvent.mockReturnValue({ locals: { did: ALICE, session: {} } });
	mocks.callerSession.mockResolvedValue(caller);
	mocks.requireGroupWriter.mockResolvedValue(writer);
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

	it('cancels a request and leaves, as the person', async () => {
		expect(await cancelJoin({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.cancelJoinRequest).toHaveBeenCalledWith(caller, GROUP);
		expect(await leave({ groupDid: GROUP })).toEqual({ ok: true });
		expect(mocks.leaveGroup).toHaveBeenCalledWith(caller, GROUP);
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
			() => leave({ groupDid: GROUP })
		]) {
			await expect(run()).rejects.toMatchObject({ status: 404 });
		}
		expect(mocks.callerSession).not.toHaveBeenCalled();
	});
});

describe("an admin's acts on the members page", () => {
	it('admits, denies, changes a role and removes, each as the group through their own link', async () => {
		expect(await approveRequest({ groupDid: GROUP, did: BOB })).toEqual({ ok: true });
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.admitMember).toHaveBeenCalledWith(writer, BOB);
		expect(await denyRequest({ groupDid: GROUP, did: BOB })).toEqual({ ok: true });
		expect(mocks.denyJoinRequest).toHaveBeenCalledWith(writer, BOB);
		expect(await changeRole({ groupDid: GROUP, did: BOB, admin: true })).toEqual({ ok: true });
		// Their membership is read with the admin's own access.
		expect(mocks.setMemberAdmin).toHaveBeenCalledWith(writer, caller, BOB, true);
		expect(await removeFromGroup({ groupDid: GROUP, did: BOB })).toEqual({ ok: true });
		expect(mocks.removeMember).toHaveBeenCalledWith(writer, BOB);
	});

	it.each([
		['last-admin', 409, 'no admin'],
		['not-assignable', 403, "doesn't let you give or take that role"],
		['scope-not-held', 403, "doesn't hold what that role would give"],
		['member-role', 400, 'keeps the member role'],
		['no-request', 409, 'no longer asking to join'],
		['already-member', 409, 'a member already'],
		['not-member', 409, 'no longer a member']
	] as const)(
		'says why in plain words when the host refuses: %s',
		async (reason, status, words) => {
			mocks.removeMember.mockRejectedValue(new RosterRefused(reason));
			await expect(removeFromGroup({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
				status,
				body: { message: expect.stringContaining(words) }
			});
		}
	);

	it('says when their role no longer allows it, or their link broke, and hides any other failure', async () => {
		mocks.admitMember.mockRejectedValue(
			new XrpcError('com.atproto.space.createRecord', 403, 'Forbidden')
		);
		await expect(approveRequest({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
			status: 403,
			body: { message: 'Your role in this group no longer allows that.' }
		});
		mocks.admitMember.mockRejectedValue(
			new XrpcError('com.atproto.space.createRecord', 403, 'ScopeMissing')
		);
		await expect(approveRequest({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
			status: 403
		});
		mocks.admitMember.mockRejectedValue(new XrpcError('com.atproto.space.createRecord', 401, null));
		await expect(approveRequest({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
			status: 403,
			body: { message: expect.stringContaining('Link it again') }
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.admitMember.mockRejectedValue(new Error('the host said something private'));
		await expect(approveRequest({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
			status: 502,
			body: { message: 'The group host could not be reached. Try again shortly.' }
		});
	});

	it('is the same 404 without a link, and writes nothing', async () => {
		mocks.requireGroupWriter.mockRejectedValue(
			Object.assign(new Error('Group not found'), { status: 404 })
		);
		await expect(approveRequest({ groupDid: GROUP, did: BOB })).rejects.toMatchObject({
			status: 404
		});
		expect(mocks.admitMember).not.toHaveBeenCalled();
	});

	it('is a 404 with groups off, before looking for a link', async () => {
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		for (const run of [
			() => approveRequest({ groupDid: GROUP, did: BOB }),
			() => denyRequest({ groupDid: GROUP, did: BOB }),
			() => changeRole({ groupDid: GROUP, did: BOB, admin: true }),
			() => removeFromGroup({ groupDid: GROUP, did: BOB })
		]) {
			await expect(run()).rejects.toMatchObject({ status: 404 });
		}
		expect(mocks.requireGroupWriter).not.toHaveBeenCalled();
		expect(mocks.callerSession).not.toHaveBeenCalled();
	});
});

// The real-host adapter against the group host's own replies, recorded on the
// devnet (OKF runs/2026-10-14-group-host-day4/run-day4.log, and the 2026-10-15
// OAuth probe, atproto-group-host spike/probe-day5-3.mjs). A member's acts go to
// their own PDS, which forwards them to the host; the group's methods go to the
// host on the caller's own group session. D1 keeps only the roster cache and the
// note that a person asked.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { scopes } from '$lib/atproto/settings';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { linkGroups, SESSION_PERSON_HEADER, unlinkAllGroups } from './__fixtures__/linked-group';
import { seedGroup } from './__fixtures__/seed-group';
import { authzReader } from './__fixtures__/members-space';
import type { GroupRow } from '../types';
import type { MemberSession } from './acceptance';
import { getMemberRow, pendingRequestIdOf } from './db/roster';
import { GroupRuleError } from './db/rules';
import { pendingRequestsFor } from './host';
import { HostSignInError, isHostGroup, realGroupHost } from './real-host';
import { GroupPermissionError } from './group-write';
import { GroupCredentialError } from './session';

const HOST = 'https://grouphost.test';
const GROUP_DID = 'did:plc:66pgsrgfxpd66hpqpneupgo4';
const OWNER = 'did:plc:ownerownerownerownerowne';
const BOB = 'did:plc:oyjdc5luxterikvai2ouko4q';
const ALICE = 'did:plc:miiewq2j3v645ss37hfngpyf';

/** The host's replies, as recorded. */
const REPLY = {
	admitted: {
		status: 'admitted',
		membership: {
			uri: `at://${GROUP_DID}/space/group.opensocial.members/self/${GROUP_DID}/group.opensocial.membership/${BOB}`,
			cid: 'bafyreihupokxtlobli2hkvtmnhfwpwar2gtztyenhfq4fgb52x6iordfbm'
		}
	},
	pending: { status: 'pending', request: { member: BOB, createdAt: '2026-10-15T20:08:46.883Z' } },
	joinClosed: { error: 'JoinClosed', message: 'this group admits by invitation only' },
	noRequest: { error: 'JoinRequestNotFound', message: 'you have no pending join request' },
	scopeMissing: {
		error: 'ScopeMissingError',
		message: `Missing required scope "rpc:group.opensocial.requestJoin?aud=${GROUP_DID}%23atproto_pds"`
	},
	listPage1: {
		requests: [{ member: BOB, createdAt: '2026-10-15T02:47:41.311Z', message: 'please let me in' }],
		cursor: `2026-10-15T02:47:41.311Z|${BOB}`
	},
	listPage2: { requests: [] }
} as const;

interface Sent {
	pathname: string;
	headers: Headers;
	body: Record<string, unknown> | null;
}

/** Bob's own session at his PDS: records each request and answers with the
 *  next reply. It holds no acceptance grant, so a join writes no acceptance. */
function bobsSession(...replies: [number, unknown][]): MemberSession & { sent: Sent[] } {
	const sent: Sent[] = [];
	return {
		did: BOB,
		scope: 'atproto',
		sent,
		handle: async (pathname, init) => {
			sent.push({
				pathname,
				headers: new Headers(init.headers),
				body: init.body ? JSON.parse(String(init.body)) : null
			});
			const [status, body] = replies.shift() ?? [500, { error: 'NoReplyLeft' }];
			return Response.json(body, { status });
		}
	};
}

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let hostCalls: { url: URL; person: string | null; body: unknown }[];
let hostReplies: [number, unknown][];

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		requireApproval: true
	}));
	hostCalls = [];
	hostReplies = [];
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		hostCalls.push({
			url: new URL(String(input)),
			person: headers.get(SESSION_PERSON_HEADER),
			body: init?.body ? JSON.parse(String(init.body)) : null
		});
		const [status, body] = hostReplies.shift() ?? [500, { error: 'NoReplyLeft' }];
		return Response.json(body, { status });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
	harness.close();
});

const host = (env: object = {}) => realGroupHost({ db, env, group });

describe('a member’s own acts, through their own PDS', () => {
	it('an open join admits: the call names the group, goes for its host, and the roster cache gains them', async () => {
		const member = bobsSession([200, REPLY.admitted]);

		await expect(host().requestJoin({ callerDid: BOB, member }, null)).resolves.toBe('joined');

		expect(member.sent).toHaveLength(1);
		const [call] = member.sent;
		expect(call.pathname).toBe('/xrpc/group.opensocial.requestJoin');
		expect(call.headers.get('atproto-proxy')).toBe(`${GROUP_DID}#atproto_pds`);
		expect(call.body).toEqual({ group: GROUP_DID });
		expect((await getMemberRow(db, group.id, BOB))?.role).toBe('member');
		expect(await pendingRequestIdOf(db, group.id, BOB)).toBeNull();
	});

	it('an approval join queues: the host keeps the request, and this app notes that they asked', async () => {
		const member = bobsSession([200, REPLY.pending], [200, REPLY.pending]);
		const realHost = host();

		await expect(realHost.requestJoin({ callerDid: BOB, member }, 'hello')).resolves.toBe(
			'pending'
		);
		expect(member.sent[0].body).toEqual({ group: GROUP_DID, message: 'hello' });
		expect(await pendingRequestIdOf(db, group.id, BOB)).not.toBeNull();
		expect(await getMemberRow(db, group.id, BOB)).toBeNull();

		// The host answers a second ask with the same request.
		await expect(realHost.requestJoin({ callerDid: BOB, member }, null)).resolves.toBe(
			'already-pending'
		);
	});

	it('an invite group answers JoinClosed, which reads as invite-only, and nothing is noted', async () => {
		const member = bobsSession([400, REPLY.joinClosed]);

		const thrown = await host()
			.requestJoin({ callerDid: BOB, member }, null)
			.catch((e) => e);

		expect(thrown).toBeInstanceOf(GroupRuleError);
		expect(thrown.reason).toBe('invite-only');
		expect(await pendingRequestIdOf(db, group.id, BOB)).toBeNull();
		expect(await getMemberRow(db, group.id, BOB)).toBeNull();
	});

	it('a cancel with nothing pending answers JoinRequestNotFound, and the note closes anyway', async () => {
		const member = bobsSession([200, REPLY.pending], [400, REPLY.noRequest]);
		const realHost = host();
		await realHost.requestJoin({ callerDid: BOB, member }, null);

		const thrown = await realHost.cancelJoinRequest({ callerDid: BOB, member }).catch((e) => e);

		expect(member.sent[1].pathname).toBe('/xrpc/group.opensocial.cancelJoinRequest');
		expect(thrown).toBeInstanceOf(GroupRuleError);
		expect(thrown.reason).toBe('not-found');
		expect(await pendingRequestIdOf(db, group.id, BOB)).toBeNull();
	});

	it('the sign-in asks for each method a member’s own act sends', () => {
		expect(scopes).toEqual(
			expect.arrayContaining(
				['requestJoin', 'cancelJoinRequest', 'leaveGroup'].map(
					(method) => `rpc:group.opensocial.${method}?aud=*`
				)
			)
		);
	});

	it('a sign-in without the rpc: scope is refused at their PDS, as a sign-in to redo', async () => {
		const member = bobsSession([403, REPLY.scopeMissing]);

		await expect(host().requestJoin({ callerDid: BOB, member }, null)).rejects.toBeInstanceOf(
			HostSignInError
		);
	});

	it('nobody else’s session speaks for the caller, and none sends nothing', async () => {
		const member = bobsSession([200, REPLY.admitted]);

		await expect(host().leaveGroup({ callerDid: ALICE, member })).rejects.toBeInstanceOf(
			HostSignInError
		);
		await expect(host().requestJoin({ callerDid: BOB }, null)).rejects.toBeInstanceOf(
			HostSignInError
		);
		expect(member.sent).toEqual([]);
	});

	it('a leave goes to the host, then the roster cache drops them', async () => {
		const member = bobsSession([200, REPLY.admitted], [200, {}]);
		const realHost = host();
		await realHost.requestJoin({ callerDid: BOB, member }, null);

		await realHost.leaveGroup({ callerDid: BOB, member });

		expect(member.sent[1].pathname).toBe('/xrpc/group.opensocial.leaveGroup');
		expect(member.sent[1].body).toEqual({ group: GROUP_DID });
		expect(await getMemberRow(db, group.id, BOB)).toBeNull();
	});
});

describe('the group’s own methods, on the caller’s group session', () => {
	it('lists every page of requests with the caller’s own session, a request named by its member', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);
		hostReplies = [
			[200, REPLY.listPage1],
			[200, REPLY.listPage2]
		];

		const rows = await host(env).listJoinRequests({ callerDid: ALICE });

		expect(rows).toEqual([
			{
				id: BOB,
				did: BOB,
				status: 'pending',
				message: 'please let me in',
				created_at: Date.parse('2026-10-15T02:47:41.311Z')
			}
		]);
		expect(hostCalls.map((c) => [c.url.origin, c.url.pathname, c.person])).toEqual([
			[HOST, '/xrpc/group.opensocial.listJoinRequests', ALICE],
			[HOST, '/xrpc/group.opensocial.listJoinRequests', ALICE]
		]);
		expect(hostCalls[1].url.searchParams.get('cursor')).toBe(REPLY.listPage1.cursor);
	});

	it('a caller who linked no session is refused before anything is sent', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);

		await expect(host(env).listJoinRequests({ callerDid: BOB })).rejects.toBeInstanceOf(
			GroupCredentialError
		);
		expect(hostCalls).toEqual([]);
	});

	it('a deny names the member, and closes this app’s note of their request', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);
		const member = bobsSession([200, REPLY.pending]);
		await host(env).requestJoin({ callerDid: BOB, member }, null);
		hostReplies = [[200, {}]];

		await host(env).denyJoinRequest({ callerDid: ALICE }, BOB);

		expect(hostCalls[0].url.pathname).toBe('/xrpc/group.opensocial.denyJoinRequest');
		expect(hostCalls[0].body).toEqual({ member: BOB });
		expect(hostCalls[0].person).toBe(ALICE);
		expect(await pendingRequestIdOf(db, group.id, BOB)).toBeNull();
	});
});

describe('membership writes, on the acting person’s own group session', () => {
	const PUBLISHED = '2026-09-01T12:00:00.000Z';
	const roster = { [OWNER]: 'owner', [ALICE]: 'admin', [BOB]: 'member' } as const;
	const asAlice = () => ({ callerDid: ALICE, reader: authzReader(GROUP_DID, roster) });
	const ref = {
		uri: `at://${GROUP_DID}/x/y`,
		cid: 'bafyreihupokxtlobli2hkvtmnhfwpwar2gtztyenhfq4fgb52x6iordfbm'
	};

	it('an add writes the member’s membership at the host on the caller’s own session, then caches the row', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);
		hostReplies = [[200, ref]];

		await host(env).addMember(asAlice(), BOB, 'member');

		expect(hostCalls.map((c) => [c.url.origin, c.url.pathname, c.person])).toEqual([
			[HOST, '/xrpc/com.atproto.space.putRecord', ALICE]
		]);
		expect(hostCalls[0].body).toMatchObject({
			repo: GROUP_DID,
			collection: 'group.opensocial.membership',
			rkey: BOB,
			record: { member: BOB, roles: ['member'] }
		});
		expect((await getMemberRow(db, group.id, BOB))?.role).toBe('member');
	});

	it('an eject deletes the membership at the host, then the row; the owner is refused with nothing sent', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);
		hostReplies = [
			[200, ref],
			[200, {}]
		];
		await host(env).addMember(asAlice(), BOB, 'member');

		const owner = await host(env)
			.ejectMember(asAlice(), OWNER)
			.catch((e) => e);
		expect(owner).toBeInstanceOf(GroupRuleError);
		expect(owner.reason).toBe('owner-protected');

		await host(env).ejectMember(asAlice(), BOB);
		expect(hostCalls.map((c) => c.url.pathname)).toEqual([
			'/xrpc/com.atproto.space.putRecord',
			'/xrpc/com.atproto.space.deleteRecord'
		]);
		expect(hostCalls[1].body).toMatchObject({
			collection: 'group.opensocial.membership',
			rkey: BOB
		});
		expect(await getMemberRow(db, group.id, BOB)).toBeNull();
	});

	// The host decides: this app's own gate asks nothing, and sends the write on
	// the member's own session, which the host cuts to their roles. (Spec: SC-503.)
	it('a plain member’s add and eject go to the host unchecked here, and its refusals read as not allowed', async () => {
		const env = { ...linkGroups([GROUP_DID], HOST, [BOB]), GROUP_HOST_URL: HOST };
		const spaceCredential = await import('./space-credential');
		const resolve = vi.spyOn(spaceCredential.didSpaceHosts, 'repoHost').mockResolvedValue(HOST);
		const reader = authzReader(GROUP_DID, roster);
		hostReplies = [
			[403, { error: 'Forbidden', message: 'your roles cannot assign or remove member' }],
			[403, { error: 'ScopeMissingError', message: 'Missing required scope "space:…"' }]
		];

		const add = await host(env)
			.addMember({ callerDid: BOB, reader }, ALICE, 'member')
			.catch((e) => e);
		const eject = await host(env)
			.ejectMember({ callerDid: BOB, reader }, ALICE)
			.catch((e) => e);
		resolve.mockRestore();

		expect(add).toBeInstanceOf(GroupPermissionError);
		expect(add.reason).toBe('your roles may not assign or remove that role');
		expect(eject).toBeInstanceOf(GroupPermissionError);
		expect(eject.reason).toBe('your roles do not allow com.atproto.space.deleteRecord');
		expect(hostCalls.map((c) => [c.url.pathname, c.person])).toEqual([
			['/xrpc/com.atproto.space.putRecord', BOB],
			['/xrpc/com.atproto.space.deleteRecord', BOB]
		]);
		expect(reader.calls).toEqual([]);
		expect((await getMemberRow(db, group.id, ALICE))?.role).toBeUndefined();
	});

	it('a role change keeps the published date, read with the caller’s own access', async () => {
		const env = linkGroups([GROUP_DID], HOST, [ALICE]);
		hostReplies = [[200, ref]];

		await host(env).setMemberRole(asAlice(), BOB, 'admin');

		expect(hostCalls[0].body).toMatchObject({
			rkey: BOB,
			record: { member: BOB, roles: ['admin'], createdAt: PUBLISHED }
		});
		expect((await getMemberRow(db, group.id, BOB))?.role).toBe('admin');
	});
});

describe('isHostGroup', () => {
	const at = (endpoint: string) => ({ repoHost: async () => endpoint });

	it('with no host set up, no group is the host’s, and nothing is resolved', async () => {
		const repoHost = vi.fn(async () => HOST);
		await expect(isHostGroup({}, GROUP_DID, { repoHost })).resolves.toBe(false);
		expect(repoHost).not.toHaveBeenCalled();
	});

	it('a group whose PDS is the host is the host’s; any other is not', async () => {
		const env = { GROUP_HOST_URL: `${HOST}/` };
		await expect(isHostGroup(env, GROUP_DID, at(HOST))).resolves.toBe(true);
		await expect(isHostGroup(env, GROUP_DID, at('https://pds.stub.test'))).resolves.toBe(false);
	});
});

describe('pendingRequestsFor', () => {
	it('is null for a viewer with no group session at a host group', async () => {
		const env = { ...linkGroups([GROUP_DID], HOST, [ALICE]), GROUP_HOST_URL: HOST };
		const spaceCredential = await import('./space-credential');
		const resolve = vi.spyOn(spaceCredential.didSpaceHosts, 'repoHost').mockResolvedValue(HOST);

		await expect(pendingRequestsFor({ db, env, group }, { callerDid: BOB })).resolves.toBeNull();
		expect(hostCalls).toEqual([]);
		resolve.mockRestore();
	});
});

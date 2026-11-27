import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	SpaceAccessDenied,
	type SpaceCall,
	type SpaceHosts
} from '#lib/spaces/server/space-credential.js';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	exchangeSpaceCredential: vi.fn(),
	fetchWithCredential: vi.fn(),
	spaceIdentity: vi.fn(),
	personGet: vi.fn()
}));
vi.mock('#lib/spaces/server/space-credential.js', async (importActual) => ({
	...(await importActual<typeof import('#lib/spaces/server/space-credential.js')>()),
	exchangeSpaceCredential: mocks.exchangeSpaceCredential,
	fetchWithCredential: mocks.fetchWithCredential,
	spaceIdentity: mocks.spaceIdentity
}));
vi.mock('./person', () => ({ personReader: () => ({ get: mocks.personGet }) }));

import {
	admitMember,
	denyJoinRequest,
	listJoinRequests,
	readRoster,
	removeMember,
	RosterRefused,
	setMemberAdmin
} from './roster';
import { XrpcError } from './xrpc';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const CAROL = 'did:web:carol.example%3A8443';
const MEMBERS = `at:space/${GROUP}/org.atgrp.members/self`;
const HOSTS: SpaceHosts = {
	repoHost: async (did) => (did === GROUP ? 'https://host.example' : `https://pds.${did}`),
	kemKey: async () => 'did:key:z'
};
const caller = { did: ALICE, scope: 'atproto', handle: vi.fn() };

/** The members space as the credential reads it: pages of records by collection, and the
 *  confirmations in members' own repos. */
function space(
	pages: Record<string, unknown[][]>,
	confirmed: Record<string, 'yes' | 'no' | 'down'> = {}
) {
	mocks.fetchWithCredential.mockImplementation(
		async (_cred: unknown, _hosts: unknown, call: SpaceCall) => {
			if (call.nsid === 'com.atproto.space.listRecords') {
				const all = pages[call.query.collection] ?? [[]];
				const at = Number(call.query.cursor ?? 0);
				// The group host's `cursor: null` on the last page.
				const cursor = at + 1 < all.length ? String(at + 1) : null;
				return Response.json({ records: all[at], cursor });
			}
			const state = confirmed[call.query.repo] ?? 'no';
			if (state === 'yes') return Response.json({ uri: 'u', cid: 'c', value: { createdAt: 'x' } });
			if (state === 'down') return new Response(null, { status: 502 });
			return Response.json({ error: 'RecordNotFound' }, { status: 400 });
		}
	);
}

const membership = (rkey: string, roles: string[], createdAt: string) => ({
	collection: 'org.atgrp.membership',
	rkey,
	cid: 'c',
	value: { $type: 'org.atgrp.membership', roles, createdAt }
});
const role = (rkey: string, displayName?: string) => ({
	collection: 'org.atgrp.role',
	rkey,
	cid: 'c',
	value: { $type: 'org.atgrp.role', ...(displayName ? { displayName } : {}) }
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.exchangeSpaceCredential.mockResolvedValue({ token: 't', signer: {} });
	mocks.spaceIdentity.mockImplementation(async (did: string) => ({
		pds: 'https://pds.example',
		handle: did === BOB ? 'handle.invalid' : `${did.split(':').at(-1)}.example`
	}));
});

describe('the roster, read with the person’s own access', () => {
	it('lists every membership across pages, with roles, handles and confirmations, oldest first', async () => {
		space(
			{
				'org.atgrp.membership': [
					[membership(ALICE, ['member', 'admin'], '2026-11-02T00:00:00Z')],
					[
						membership(BOB, ['member'], '2026-11-01T00:00:00Z'),
						membership('did:web:carol.example:8443', ['member', 'rider'], '2026-11-03T00:00:00Z')
					]
				],
				'org.atgrp.role': [
					[role('member', 'Member'), role('rider'), role('aide'), role('admin', 'Admin')]
				]
			},
			{ [BOB]: 'yes', [CAROL]: 'down' }
		);
		const roster = await readRoster(caller, GROUP, true, HOSTS);
		expect(roster.entries).toEqual([
			{
				did: BOB,
				handle: null,
				roles: ['member'],
				createdAt: '2026-11-01T00:00:00Z',
				confirmed: true
			},
			{
				did: ALICE,
				handle: 'alice.example',
				roles: ['member', 'admin'],
				createdAt: '2026-11-02T00:00:00Z',
				// Their own, as the group was read for them.
				confirmed: true
			},
			{
				// The record key's port written plain, the DID's encoded.
				did: CAROL,
				handle: 'carol.example%3A8443.example',
				roles: ['member', 'rider'],
				createdAt: '2026-11-03T00:00:00Z',
				// A confirmation that could not be read counts as not there.
				confirmed: false
			}
		]);
		// Admin, then member, then the rest by ID.
		expect(roster.roles).toEqual([
			{ id: 'admin', name: 'Admin' },
			{ id: 'member', name: 'Member' },
			{ id: 'aide', name: 'aide' },
			{ id: 'rider', name: 'rider' }
		]);
		expect(roster.yours).toEqual(['member', 'admin']);
		// One credential for the members space, bought with the person's own session, at the host.
		expect(mocks.exchangeSpaceCredential).toHaveBeenCalledTimes(1);
		expect(mocks.exchangeSpaceCredential).toHaveBeenCalledWith(
			caller,
			MEMBERS,
			'https://host.example'
		);
		expect(mocks.fetchWithCredential).toHaveBeenCalledWith(expect.anything(), HOSTS, {
			host: 'https://pds.did:plc:bob',
			audience: BOB,
			nsid: 'com.atproto.space.getRecord',
			query: { space: MEMBERS, repo: BOB, collection: 'org.atgrp.confirmation', rkey: 'self' }
		});
	});

	it("takes the caller's own confirmation as already read for them, without reading it again", async () => {
		space({ 'org.atgrp.membership': [[membership(ALICE, ['member'], 'x')]] }, { [ALICE]: 'yes' });
		expect((await readRoster(caller, GROUP, false, HOSTS)).entries[0].confirmed).toBe(false);
		expect(mocks.fetchWithCredential).not.toHaveBeenCalledWith(
			expect.anything(),
			HOSTS,
			expect.objectContaining({ audience: ALICE })
		);
	});

	it("reads the caller's own confirmation when it was not read already", async () => {
		space({ 'org.atgrp.membership': [[membership(ALICE, ['member'], 'x')]] });
		expect((await readRoster(caller, GROUP, null, HOSTS)).entries[0].confirmed).toBe(false);
		space({ 'org.atgrp.membership': [[membership(ALICE, ['member'], 'x')]] }, { [ALICE]: 'yes' });
		expect((await readRoster(caller, GROUP, null, HOSTS)).entries[0].confirmed).toBe(true);
	});

	it('leaves out records of another collection, and memberships with no roles', async () => {
		space({
			'org.atgrp.membership': [
				[
					membership(ALICE, ['member'], 'x'),
					// Shaped as a membership, so only its collection gives it away.
					{ ...membership(BOB, ['member'], 'x'), collection: 'org.atgrp.role' },
					{ collection: 'org.atgrp.membership', rkey: CAROL, value: { createdAt: 'x' } }
				]
			]
		});
		expect((await readRoster(caller, GROUP, true, HOSTS)).entries.map((e) => e.did)).toEqual([
			ALICE
		]);
	});

	it('throws when the host does not let them read it, or a list fails', async () => {
		const denied = new SpaceAccessDenied(MEMBERS, '400 NotAuthorized');
		mocks.exchangeSpaceCredential.mockRejectedValue(denied);
		await expect(readRoster(caller, GROUP, true, HOSTS)).rejects.toBe(denied);

		mocks.exchangeSpaceCredential.mockResolvedValue({ token: 't', signer: {} });
		mocks.fetchWithCredential.mockResolvedValue(new Response(null, { status: 500 }));
		await expect(readRoster(caller, GROUP, true, HOSTS)).rejects.toBeInstanceOf(XrpcError);
	});
});

/** The group's session at its host, answering each call with `answer`. */
function writer(answer: (path: string, init: RequestInit) => Response = () => Response.json({})) {
	const handle = vi.fn<XrpcHandle>(async (path, init) => answer(path, init));
	return { did: GROUP, handle };
}
const body = (handle: ReturnType<typeof writer>['handle'], call = 0) =>
	JSON.parse(String(handle.mock.calls[call][1].body));
const refusal =
	(error: string, status = 400) =>
	() =>
		Response.json({ error }, { status });

describe('the join requests, as the group', () => {
	it('reads every page, taking the host’s null cursor as the end, with handles', async () => {
		const g = writer((path) => {
			const url = new URL(path, 'https://host.example');
			if (!url.searchParams.get('cursor')) {
				return Response.json({
					requests: [
						{ member: BOB, createdAt: '2026-11-02T00:00:00Z', message: '  I ride.  ' },
						{ member: 'not a did', createdAt: 'x' }
					],
					cursor: '7'
				});
			}
			return Response.json({
				requests: [{ member: CAROL, createdAt: '2026-11-01T00:00:00Z' }],
				cursor: null
			});
		});
		expect(await listJoinRequests(g)).toEqual([
			{ did: BOB, createdAt: '2026-11-02T00:00:00Z', message: 'I ride.', handle: null },
			{
				did: CAROL,
				createdAt: '2026-11-01T00:00:00Z',
				message: null,
				handle: 'carol.example%3A8443.example'
			}
		]);
		expect(g.handle.mock.calls.map(([path]) => path)).toEqual([
			'/xrpc/org.atgrp.listJoinRequests?limit=100',
			'/xrpc/org.atgrp.listJoinRequests?limit=100&cursor=7'
		]);
	});

	it('denies by the member alone, and refuses a request no longer waiting as approving does', async () => {
		const g = writer();
		await denyJoinRequest(g, BOB);
		expect(g.handle).toHaveBeenCalledWith('/xrpc/org.atgrp.denyJoinRequest', expect.anything());
		expect(body(g.handle)).toEqual({ member: BOB });
		// Another admin may have approved them meanwhile: not reported as turned down.
		await expect(denyJoinRequest(writer(refusal('JoinRequestNotFound')), BOB)).rejects.toEqual(
			new RosterRefused('no-request')
		);
		await expect(denyJoinRequest(writer(refusal('Forbidden', 403)), BOB)).rejects.toMatchObject({
			status: 403,
			error: 'Forbidden'
		});
	});
});

describe('admitting, as the group', () => {
	it("creates the requester's membership, keyed by their DID, holding member, with no member field", async () => {
		const g = writer();
		await admitMember(g, CAROL, new Date('2026-11-04T00:00:00Z'));
		expect(g.handle).toHaveBeenCalledWith(
			'/xrpc/com.atproto.space.createRecord',
			expect.anything()
		);
		expect(body(g.handle)).toEqual({
			repo: GROUP,
			space: MEMBERS,
			collection: 'org.atgrp.membership',
			rkey: 'did:web:carol.example:8443',
			record: {
				$type: 'org.atgrp.membership',
				roles: ['member'],
				createdAt: '2026-11-04T00:00:00.000Z'
			}
		});
	});

	it.each([
		['JoinRequestNotFound', 'no-request'],
		['InvalidRequest', 'already-member']
	])('names the host’s %s', async (error, reason) => {
		await expect(admitMember(writer(refusal(error)), BOB)).rejects.toEqual(
			new RosterRefused(reason as never)
		);
	});
});

describe('changing roles, as the group', () => {
	beforeEach(() => {
		mocks.personGet.mockResolvedValue({
			uri: 'u',
			cid: 'c',
			rkey: BOB,
			value: { roles: ['member', 'rider'], createdAt: '2026-11-01T00:00:00Z' }
		});
	});

	it('rewrites the membership read as the admin, keeping its date and other roles, with member', async () => {
		const g = writer();
		await setMemberAdmin(g, caller, BOB, true);
		expect(mocks.personGet).toHaveBeenCalledWith({
			space: MEMBERS,
			repo: GROUP,
			collection: 'org.atgrp.membership',
			rkey: BOB
		});
		expect(g.handle).toHaveBeenCalledWith('/xrpc/com.atproto.space.putRecord', expect.anything());
		expect(body(g.handle).record).toEqual({
			$type: 'org.atgrp.membership',
			roles: ['member', 'admin', 'rider'],
			createdAt: '2026-11-01T00:00:00Z'
		});

		mocks.personGet.mockResolvedValue({
			uri: 'u',
			cid: 'c',
			rkey: BOB,
			value: { roles: ['admin', 'rider'], createdAt: '2026-11-01T00:00:00Z' }
		});
		await setMemberAdmin(g, caller, BOB, false);
		expect(body(g.handle, 1).record.roles).toEqual(['member', 'rider']);
	});

	it('says so for someone no longer a member, and writes nothing', async () => {
		mocks.personGet.mockResolvedValue(null);
		const g = writer();
		await expect(setMemberAdmin(g, caller, BOB, true)).rejects.toEqual(
			new RosterRefused('not-member')
		);
		expect(g.handle).not.toHaveBeenCalled();
	});

	it.each([
		['LastConfigurer', 'last-admin'],
		['NotAssignable', 'not-assignable'],
		['ScopeNotHeld', 'scope-not-held'],
		['MemberRole', 'member-role']
	])('names the host’s %s', async (error, reason) => {
		await expect(setMemberAdmin(writer(refusal(error)), caller, BOB, false)).rejects.toEqual(
			new RosterRefused(reason as never)
		);
	});

	it('leaves a refused role or scope as it was thrown', async () => {
		await expect(
			setMemberAdmin(writer(refusal('ScopeMissing', 403)), caller, BOB, true)
		).rejects.toMatchObject({ status: 403, error: 'ScopeMissing' });
	});
});

describe('removing, as the group', () => {
	it('deletes the membership, and takes one already gone as done', async () => {
		const g = writer();
		await removeMember(g, BOB);
		expect(g.handle).toHaveBeenCalledWith(
			'/xrpc/com.atproto.space.deleteRecord',
			expect.anything()
		);
		expect(body(g.handle)).toEqual({
			repo: GROUP,
			space: MEMBERS,
			collection: 'org.atgrp.membership',
			rkey: BOB
		});
		await expect(removeMember(writer(refusal('InvalidRequest')), BOB)).resolves.toBe(undefined);
	});

	it('names the host’s refusal, such as removing the last admin', async () => {
		await expect(removeMember(writer(refusal('LastConfigurer')), BOB)).rejects.toEqual(
			new RosterRefused('last-admin')
		);
	});
});

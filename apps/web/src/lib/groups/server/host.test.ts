import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupHostInfo } from './host-api';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	networkFetch: vi.fn<typeof fetch>(),
	groupHostInfo: vi.fn(),
	withdrawConfirmation: vi.fn()
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('./host-api', () => ({ groupHostInfo: mocks.groupHostInfo }));
vi.mock('./confirmation', () => ({ withdrawConfirmation: mocks.withdrawConfirmation }));

import {
	actorGroups,
	cancelJoinRequest,
	GroupActionRefused,
	leaveGroup,
	requestJoin
} from './host';
import { XrpcError } from './xrpc';

const ALICE = 'did:plc:alice';
const GROUP = 'did:plc:group';
const HOST: GroupHostInfo = {
	origin: 'https://host.example',
	did: 'did:web:host.example',
	domain: '.groups.example',
	newGroupUrl: 'https://host.example/new'
};

/** The person's own session at their PDS, which answers getServiceAuth. */
function caller(answer: () => Response = () => Response.json({ token: 'service-jwt' })) {
	const handle = vi.fn<XrpcHandle>(async () => answer());
	return { did: ALICE, scope: 'atproto', handle };
}

/** The group host, answering each call with `answer`. */
function hostAnswers(answer: (url: URL) => Response) {
	mocks.networkFetch.mockImplementation(async (input) => answer(new URL(String(input))));
}

const refusal = (error: string) => () => Response.json({ error }, { status: 400 });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.groupHostInfo.mockResolvedValue(HOST);
	mocks.withdrawConfirmation.mockResolvedValue(undefined);
});

describe('joining a group', () => {
	it("asks the person's PDS to vouch for them to the host's DID, for requestJoin alone", async () => {
		hostAnswers(() => Response.json({ status: 'admitted', membership: { uri: 'u', cid: 'c' } }));
		const person = caller();
		expect(await requestJoin(person, GROUP, null)).toBe('joined');

		expect(person.handle.mock.calls).toEqual([
			[
				'/xrpc/com.atproto.server.getServiceAuth?aud=did%3Aweb%3Ahost.example&lxm=org.atgrp.requestJoin',
				{ method: 'GET' }
			]
		]);
		const [url, init] = mocks.networkFetch.mock.calls[0];
		expect(String(url)).toBe('https://host.example/xrpc/org.atgrp.requestJoin');
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-jwt');
		expect(JSON.parse(String(init?.body))).toEqual({ group: GROUP });
	});

	it('sends the message with a request, which waits for the admins', async () => {
		hostAnswers(() =>
			Response.json({ status: 'pending', request: { member: ALICE, createdAt: 'now' } })
		);
		expect(await requestJoin(caller(), GROUP, 'I knit.')).toBe('pending');
		expect(JSON.parse(String(mocks.networkFetch.mock.calls[0][1]?.body))).toEqual({
			group: GROUP,
			message: 'I knit.'
		});
	});

	it.each([
		['JoinClosed', 'join-closed'],
		['GroupNotFound', 'group-not-found']
	])('reads %s as a refusal to word', async (error, reason) => {
		hostAnswers(refusal(error));
		await expect(requestJoin(caller(), GROUP, null)).rejects.toEqual(
			new GroupActionRefused(reason as never)
		);
	});

	it('reads a PDS that will not vouch for the method as a missing permission', async () => {
		const person = caller(() => Response.json({ error: 'ScopeMissingError' }, { status: 403 }));
		await expect(requestJoin(person, GROUP, null)).rejects.toEqual(
			new GroupActionRefused('no-permission')
		);
		expect(mocks.networkFetch).not.toHaveBeenCalled();
	});

	it('throws an outage at the host as one, never a refusal', async () => {
		hostAnswers(() => new Response('', { status: 502 }));
		await expect(requestJoin(caller(), GROUP, null)).rejects.toBeInstanceOf(XrpcError);
	});
});

describe('cancelling a request', () => {
	it('withdraws it, and takes a request already decided as gone too', async () => {
		hostAnswers(() => Response.json({}));
		await cancelJoinRequest(caller(), GROUP);
		expect(String(mocks.networkFetch.mock.calls[0][0])).toBe(
			'https://host.example/xrpc/org.atgrp.cancelJoinRequest'
		);

		hostAnswers(refusal('JoinRequestNotFound'));
		await expect(cancelJoinRequest(caller(), GROUP)).resolves.toBeUndefined();
	});
});

describe('leaving a group', () => {
	it('withdraws the confirmation first, then leaves at the host', async () => {
		const order: string[] = [];
		mocks.withdrawConfirmation.mockImplementation(async () => order.push('confirmation'));
		hostAnswers((url) => {
			order.push(url.pathname);
			return Response.json({});
		});
		const person = caller();
		await leaveGroup(person, GROUP);
		expect(mocks.withdrawConfirmation).toHaveBeenCalledWith(person, GROUP);
		expect(order).toEqual(['confirmation', '/xrpc/org.atgrp.leaveGroup']);
		expect(person.handle.mock.calls[0][0]).toContain('lxm=org.atgrp.leaveGroup');
	});

	it("words the host's LastConfigurer, and takes NotAMember as done", async () => {
		hostAnswers(refusal('LastConfigurer'));
		await expect(leaveGroup(caller(), GROUP)).rejects.toEqual(new GroupActionRefused('last-admin'));
		hostAnswers(refusal('NotAMember'));
		await expect(leaveGroup(caller(), GROUP)).resolves.toBeUndefined();
	});
});

describe("the person's groups", () => {
	it("asks the host's own getActorGroups for them, a page at a time", async () => {
		hostAnswers((url) =>
			url.searchParams.get('cursor')
				? Response.json({ groups: [{ did: 'did:plc:two', handle: 'two.groups.example' }] })
				: Response.json({
						groups: [
							{ did: GROUP, handle: 'knit.groups.example', displayName: 'Knitters' },
							{ handle: 'no-did.groups.example' }
						],
						cursor: GROUP
					})
		);
		const person = caller();
		expect(await actorGroups(person)).toEqual([
			{ did: GROUP, handle: 'knit.groups.example', displayName: 'Knitters' },
			{ did: 'did:plc:two', handle: 'two.groups.example', displayName: null }
		]);
		expect(person.handle.mock.calls[0][0]).toContain('lxm=org.atgrp.internal.getActorGroups');
		const [url, init] = mocks.networkFetch.mock.calls[0];
		expect(String(url)).toBe(
			'https://host.example/xrpc/org.atgrp.internal.getActorGroups?actor=did%3Aplc%3Aalice&limit=100'
		);
		expect(init?.method).toBe('GET');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-jwt');
		expect(new URL(String(mocks.networkFetch.mock.calls[1][0])).searchParams.get('cursor')).toBe(
			GROUP
		);
	});
});

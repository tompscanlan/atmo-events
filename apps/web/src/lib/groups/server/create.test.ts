import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import type { GroupHostInfo } from './host-api';
import type { XrpcHandle } from './xrpc';

const mocks = vi.hoisted(() => ({
	networkFetch: vi.fn<typeof fetch>(),
	unlistGroup: vi.fn(),
	groupSession: vi.fn(),
	groupHandle: vi.fn()
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));
vi.mock('./group', () => ({ unlistGroup: mocks.unlistGroup }));
vi.mock('./sign-in', () => ({ groupSession: mocks.groupSession, groupHandle: mocks.groupHandle }));

import {
	createGroupAtHost,
	finishCreatedGroup,
	finishSetup,
	GroupNotCreated,
	parseNewGroup,
	rememberUnfinished,
	unfinishedGroup,
	unfinishedGroups,
	type NewGroup
} from './create';

const ALICE = 'did:plc:alice';
const GROUP = 'did:plc:group';
const HOST: GroupHostInfo = {
	origin: 'https://host.example',
	did: 'did:web:host.example',
	domain: '.groups.example',
	newGroupUrl: 'https://host.example/new'
};
const RIDERS: NewGroup = {
	name: 'Night Riders',
	address: 'riders',
	description: 'We ride at night.',
	joinPolicy: 'approval',
	public: true,
	listed: true
};

let kv: MemoryKV;

/** The person's own session at their PDS, which answers getServiceAuth. */
function caller(answer: () => Response = () => Response.json({ token: 'service-jwt' })) {
	const handle = vi.fn<XrpcHandle>(async () => answer());
	return { did: ALICE, scope: 'atproto', handle };
}

/** The group host's createGroup, answering with `answer`. */
function hostAnswers(answer: () => Response) {
	mocks.networkFetch.mockImplementation(async () => answer());
}

beforeEach(() => {
	vi.resetAllMocks();
	kv = memoryKV();
	Object.assign(env, { OAUTH_SESSIONS: kv, GROUP_HOST_URL: 'https://host.example' });
});

describe('a new group as the form gives it', () => {
	const form = {
		name: ' Night Riders ',
		address: 'Riders',
		description: '',
		joinPolicy: 'open',
		public: true,
		listed: true
	};

	it('is trimmed, its address lowercased, and an empty description none', () => {
		expect(parseNewGroup(form)).toEqual({
			name: 'Night Riders',
			address: 'riders',
			description: null,
			joinPolicy: 'open',
			public: true,
			listed: true
		});
	});

	it('is listed only when public', () => {
		expect(parseNewGroup({ ...form, public: false })).toMatchObject({ listed: false });
	});

	it.each([
		['no name', { name: '  ' }],
		['a name past 64 characters', { name: 'x'.repeat(65) }],
		['an address with a dot', { address: 'night.riders' }],
		['an address with an outer hyphen', { address: '-riders' }],
		['an address past one label', { address: 'x'.repeat(64) }],
		['a description past 2000 characters', { description: 'x'.repeat(2001) }],
		['a join policy the spec does not name', { joinPolicy: 'closed' }]
	])('is refused with %s', (_why, change) => {
		expect(parseNewGroup({ ...form, ...change })).toBeNull();
	});
});

describe('making a group at the group host', () => {
	it("asks the person's PDS to vouch for them to the host, then has the host make it", async () => {
		hostAnswers(() =>
			Response.json({
				did: GROUP,
				meta: `at:space/${GROUP}/org.atgrp.meta/self`,
				members: `at:space/${GROUP}/org.atgrp.members/self`
			})
		);
		const person = caller();
		expect(await createGroupAtHost(person, RIDERS, HOST)).toEqual({
			did: GROUP,
			handle: 'riders.groups.example'
		});

		expect(person.handle.mock.calls).toEqual([
			[
				'/xrpc/com.atproto.server.getServiceAuth?aud=did%3Aweb%3Ahost.example&lxm=org.atgrp.internal.createGroup',
				{ method: 'GET' }
			]
		]);
		const [url, init] = mocks.networkFetch.mock.calls[0];
		expect(String(url)).toBe('https://host.example/xrpc/org.atgrp.internal.createGroup');
		expect(init?.method).toBe('POST');
		expect(new Headers(init?.headers).get('authorization')).toBe('Bearer service-jwt');
		expect(JSON.parse(String(init?.body))).toEqual({
			handle: 'riders.groups.example',
			displayName: 'Night Riders',
			description: 'We ride at night.',
			joinPolicy: 'approval',
			metaPublicRead: true
		});
	});

	it('makes a members-only group, and sends no empty description', async () => {
		hostAnswers(() => Response.json({ did: GROUP }));
		await createGroupAtHost(caller(), { ...RIDERS, description: null, public: false }, HOST);
		const body = JSON.parse(String(mocks.networkFetch.mock.calls[0][1]?.body));
		expect(body.metaPublicRead).toBe(false);
		expect('description' in body).toBe(false);
	});

	it.each([
		[403, 'NotAllowed', 'not-allowed'],
		[400, 'HandleTaken', 'address-taken'],
		[400, 'InvalidHandle', 'address-invalid'],
		[400, 'InvalidRequest', 'invalid'],
		[400, 'AccountCreationFailed', 'unavailable'],
		[401, 'BadJwtAudience', 'unavailable'],
		[502, null, 'unavailable']
	])('reads the host’s %i %s as %s', async (status, error, reason) => {
		hostAnswers(() => Response.json(error ? { error, message: 'x' } : {}, { status }));
		const thrown = await createGroupAtHost(caller(), RIDERS, HOST).catch((e: unknown) => e);
		expect(thrown).toBeInstanceOf(GroupNotCreated);
		expect((thrown as GroupNotCreated).reason).toBe(reason);
	});

	it("goes no further when the person's PDS will not vouch for them", async () => {
		for (const [answer, reason] of [
			[() => Response.json({ error: 'ScopeMissingError' }, { status: 403 }), 'no-permission'],
			[() => Response.json({ error: 'InternalServerError' }, { status: 500 }), 'unavailable']
		] as const) {
			const thrown = await createGroupAtHost(caller(answer), RIDERS, HOST).catch((e) => e);
			expect((thrown as GroupNotCreated).reason).toBe(reason);
		}
		expect(mocks.networkFetch).not.toHaveBeenCalled();
	});
});

describe('a group made here, until its first link', () => {
	const made = { did: GROUP, handle: 'riders.groups.example', public: true, listed: false };

	it('is noted under the person who made it, for a month, and only theirs', async () => {
		await rememberUnfinished(ALICE, made);
		expect(await unfinishedGroups(ALICE)).toEqual([made]);
		expect(await unfinishedGroups('did:plc:bob')).toEqual([]);
		expect(kv.ttlOf(`group:setup:${ALICE}/${GROUP}`)).toBe(30 * 24 * 60 * 60);
	});

	it('takes a public group its maker asked not to list off the list, as the group, then forgets it', async () => {
		await rememberUnfinished(ALICE, made);
		const writer = { did: GROUP, handle: vi.fn<XrpcHandle>() };
		expect(await finishSetup(writer, ALICE)).toBe(true);
		expect(mocks.unlistGroup).toHaveBeenCalledWith(writer.handle, GROUP);
		expect(await unfinishedGroup(ALICE, GROUP)).toBeNull();
		expect(await finishSetup(writer, ALICE)).toBe(false);
	});

	it('leaves a listed or members-only group as the host made it', async () => {
		for (const group of [
			{ ...made, listed: true },
			{ ...made, public: false }
		]) {
			await rememberUnfinished(ALICE, group);
			await finishSetup({ did: GROUP, handle: vi.fn<XrpcHandle>() }, ALICE);
		}
		expect(mocks.unlistGroup).not.toHaveBeenCalled();
	});

	it('keeps the note when finishing stops, so it can be finished from the group page', async () => {
		await rememberUnfinished(ALICE, made);
		mocks.groupSession.mockResolvedValue({ did: GROUP });
		mocks.groupHandle.mockReturnValue(vi.fn());
		mocks.unlistGroup.mockRejectedValueOnce(new Error('host down'));
		expect(await finishCreatedGroup(GROUP, ALICE)).toBe('unfinished');
		expect(await unfinishedGroup(ALICE, GROUP)).toEqual(made);
		expect(await finishCreatedGroup(GROUP, ALICE)).toBe('created');
		expect(await unfinishedGroup(ALICE, GROUP)).toBeNull();
	});

	it('is nothing to finish for a group linked any other way', async () => {
		expect(await finishCreatedGroup(GROUP, ALICE)).toBeNull();
		expect(mocks.groupSession).not.toHaveBeenCalled();
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import type { OAuthClientOptions, StoredState } from '@atcute/oauth-node-client';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';
import { ROSTER_IN_THIS_BUILD } from '../build';

const mocks = vi.hoisted(() => ({
	networkFetch: vi.fn<typeof fetch>(),
	/** What each client built from now on answers a revoke with. */
	revoke: vi.fn(),
	built: [] as Array<{
		options: OAuthClientOptions;
		client: Record<string, ReturnType<typeof vi.fn>>;
	}>
}));

vi.mock('@atcute/oauth-node-client', async (importActual) => {
	const actual = await importActual<typeof import('@atcute/oauth-node-client')>();
	class OAuthClient {
		metadata: unknown;
		authorize = vi.fn(async () => ({
			url: new URL('https://host.example/oauth/authorize?request_uri=x'),
			stateId: 's1'
		}));
		callback = vi.fn();
		restore = vi.fn();
		revoke = vi.fn((did: string) => mocks.revoke(did));
		constructor(options: OAuthClientOptions) {
			this.metadata = { ...options.metadata, token_endpoint_auth_method: 'private_key_jwt' };
			mocks.built.push({ options, client: this as never });
		}
	}
	return { ...actual, OAuthClient };
});
vi.mock('#lib/atproto/server/oauth.js', () => ({
	oauthRequestLock: (_name: string, operation: () => unknown) => operation()
}));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({ fetch: mocks.networkFetch, isolated: false, assertUrl: () => {} })
}));
vi.mock('@svelte-atproto/oauth/network', () => ({ createActorResolver: () => ({}) }));
// Tested with the settings page and making groups here in the build; each check of a build without
// one names it.
vi.mock('../build', async (importOriginal) => ({
	...(await importOriginal<typeof import('../build')>()),
	CREATE_IN_THIS_BUILD: true,
	SETTINGS_IN_THIS_BUILD: true
}));

import {
	finishGroupLink,
	GROUP_SESSION_SCOPE,
	groupClientMetadata,
	groupSessionScope,
	groupSignInAvailable,
	linkAskedCurrentScope,
	linkedGroups,
	startGroupLink,
	unlinkGroup
} from './sign-in';

const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const GROUP = 'did:plc:group';

let sessions: MemoryKV;
let states: MemoryKV;

/** Each test has its own KV, so the clients it builds are its own; the last is the newest. */
function latest() {
	return mocks.built.at(-1)!;
}

async function storedState(id: string, userState: unknown) {
	const state = { userState, expiresAt: Date.now() + 60_000 } as unknown as StoredState;
	await sessions.put(`group:state:${id}`, JSON.stringify(state));
}

beforeEach(() => {
	mocks.built.length = 0;
	sessions = memoryKV();
	states = memoryKV();
	Object.assign(env, {
		OAUTH_PUBLIC_URL: 'https://atmo.example',
		CLIENT_ASSERTION_KEY: JSON.stringify({ kty: 'EC', kid: 'k' }),
		OAUTH_SESSIONS: sessions,
		OAUTH_STATES: states,
		GROUP_HOST_URL: 'https://host.example'
	});
});

describe('availability', () => {
	it.each(['OAUTH_PUBLIC_URL', 'CLIENT_ASSERTION_KEY', 'OAUTH_SESSIONS', 'GROUP_HOST_URL'])(
		'is off without %s',
		(name) => {
			Reflect.deleteProperty(env, name);
			expect(groupSignInAvailable()).toBe(false);
		}
	);
});

describe('the group client', () => {
	it('is its own client, sharing only the library key', () => {
		groupClientMetadata();
		expect(latest().options.metadata).toEqual({
			client_id: 'https://atmo.example/oauth/group/client-metadata.json',
			redirect_uris: ['https://atmo.example/oauth/group/callback'],
			jwks_uri: 'https://atmo.example/oauth/jwks.json',
			scope: GROUP_SESSION_SCOPE
		});
		expect((latest().options as { keyset?: unknown }).keyset).toEqual([{ kty: 'EC', kid: 'k' }]);
	});

	it('takes the public address as an origin, as the library does', () => {
		Object.assign(env, { OAUTH_PUBLIC_URL: 'https://atmo.example/' });
		expect(groupClientMetadata()).toMatchObject({
			client_id: 'https://atmo.example/oauth/group/client-metadata.json',
			redirect_uris: ['https://atmo.example/oauth/group/callback'],
			jwks_uri: 'https://atmo.example/oauth/jwks.json'
		});
	});

	it('waits on the group host at most the time limit', async () => {
		groupClientMetadata();
		const send = latest().options.fetch;
		expect(send).toEqual(expect.any(Function));
		const limit = new AbortController();
		const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(limit.signal);
		try {
			mocks.networkFetch.mockImplementation(
				(_input, init) =>
					new Promise((_resolve, reject) => {
						const signal = init?.signal;
						if (signal?.aborted) reject(signal.reason);
						signal?.addEventListener('abort', () => reject(signal.reason));
					})
			);
			const pending = send!('https://host.example/oauth/par', { method: 'POST' });
			limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));
			await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
		} finally {
			timeout.mockRestore();
		}
	});

	it("asks for the meta read as its own scope, writes declarations and events, the settings' records and policy, and members-only events'", () => {
		expect(GROUP_SESSION_SCOPE).toBe(groupSessionScope(ROSTER_IN_THIS_BUILD));
		expect(groupSessionScope(false).split(' ')).toEqual([
			'atproto',
			'space:org.atgrp.meta?authority=self&skey=self&action=read',
			'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
			'blob?accept=image/*',
			'space:org.atgrp.meta?authority=self&skey=self&collection=org.atgrp.about&action=read&action=update',
			'space:org.atgrp.meta?authority=self&skey=self&collection=org.atgrp.config&action=read&action=update',
			'space:org.atgrp.meta?authority=self&skey=self&manage=update',
			'space:community.lexicon.calendar.collection?authority=self&manage=create',
			'space:community.lexicon.calendar.collection?authority=self&collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete'
		]);
	});

	it("also asks for the members page's writes and calls, in a build that has it", () => {
		expect(groupSessionScope(true).split(' ')).toEqual([
			'atproto',
			'space:org.atgrp.meta?authority=self&skey=self&action=read',
			'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
			'blob?accept=image/*',
			'space:org.atgrp.meta?authority=self&skey=self&collection=org.atgrp.about&action=read&action=update',
			'space:org.atgrp.meta?authority=self&skey=self&collection=org.atgrp.config&action=read&action=update',
			'space:org.atgrp.meta?authority=self&skey=self&manage=update',
			'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.membership&action=read&action=create',
			'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.membership&action=read&action=update',
			'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.membership&action=read&action=delete',
			'rpc:org.atgrp.listJoinRequests?aud=*',
			'rpc:org.atgrp.denyJoinRequest?aud=*',
			'space:community.lexicon.calendar.collection?authority=self&manage=create',
			'space:community.lexicon.calendar.collection?authority=self&collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete'
		]);
	});

	it('asks for none of the settings in a build without them, nor anything for making groups here', () => {
		expect(groupSessionScope(false, false, false).split(' ')).toEqual([
			'atproto',
			'space:org.atgrp.meta?authority=self&skey=self&action=read',
			'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
			'blob?accept=image/*',
			'space:community.lexicon.calendar.collection?authority=self&manage=create',
			'space:community.lexicon.calendar.collection?authority=self&collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete'
		]);
	});

	it("asks, without the settings, for the meta space's policy alone while making groups here is in the build", () => {
		const asked = groupSessionScope(false, false, true).split(' ');
		expect(asked).toContain('space:org.atgrp.meta?authority=self&skey=self&manage=update');
		expect(asked.filter((token) => token.includes('org.atgrp.about'))).toEqual([]);
		expect(asked.filter((token) => token.includes('org.atgrp.config'))).toEqual([]);
		expect(groupSessionScope(false, true, true)).toBe(groupSessionScope(false, true, false));
	});

	// The host's approval page lists one row per space type, owner and key, keyed by type and owner
	// alone: a space asked for once with its key and once without makes two rows with one key, and
	// the page fails for anyone whose roles keep both. The calendar scopes name none, since the
	// group's calendar may be one another app made under a key of its own.
	it('names the same key in every scope for one space', () => {
		const keys = new Map<string, Set<string | null>>();
		const asked = groupSessionScope(true).split(' ');
		for (const token of asked.filter((t) => t.startsWith('space:'))) {
			const at = token.indexOf('?');
			const params = new URLSearchParams(at === -1 ? '' : token.slice(at + 1));
			const space = `${token.slice(0, at === -1 ? undefined : at)} ${params.get('authority')}`;
			if (!keys.has(space)) keys.set(space, new Set());
			keys.get(space)!.add(params.get('skey'));
		}
		expect(keys.size).toBeGreaterThan(1);
		const calendar = 'space:community.lexicon.calendar.collection self';
		for (const [space, skeys] of keys) {
			expect([space, [...skeys]]).toEqual([space, [space === calendar ? null : 'self']]);
		}
		expect(keys.has(calendar)).toBe(true);
	});

	it('keeps sign-in state under its prefix in OAUTH_SESSIONS, never in the library store', async () => {
		await startGroupLink(GROUP, ALICE);
		const { options } = latest();

		await options.stores.states.set('s1', { issuer: 'x' } as unknown as StoredState);
		expect(sessions.keys()).toEqual(['group:state:s1']);
		expect(sessions.ttlOf('group:state:s1')).toBe(600);
		expect(states.keys()).toEqual([]);
	});

	it("files each person's sessions under that person", async () => {
		await startGroupLink(GROUP, ALICE);
		await latest().options.stores.sessions.set(GROUP as never, {} as never);
		expect(sessions.keys()).toEqual([`group:session:${ALICE}/${GROUP}`]);
	});
});

describe('startGroupLink', () => {
	it('authorizes as the group, which the host gets as the login hint, and notes who started it', async () => {
		const url = await startGroupLink(GROUP, ALICE);
		const { client } = latest();

		expect(client.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { type: 'account', identifier: GROUP },
				scope: GROUP_SESSION_SCOPE,
				state: { groupDid: GROUP, by: ALICE }
			})
		);
		// The client's own authorization URL, with nothing added: the host keeps no other hint.
		expect(url.toString()).toBe('https://host.example/oauth/authorize?request_uri=x');
	});
});

describe('finishGroupLink', () => {
	const params = (state: string) => new URLSearchParams({ state, code: 'c', iss: 'x' });

	it('refuses a state it does not know', async () => {
		expect(await finishGroupLink(params('nope'), ALICE)).toMatchObject({
			ok: false,
			groupDid: null
		});
	});

	it('refuses a browser signed in as someone else, and spends the state', async () => {
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		expect(await finishGroupLink(params('s1'), BOB)).toMatchObject({ ok: false, groupDid: GROUP });
		expect(sessions.keys()).toEqual([]);
		expect(mocks.built.every(({ client }) => client.callback.mock.calls.length === 0)).toBe(true);
	});

	it('revokes a session that is not the group', async () => {
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		const { client } = latest();
		client.callback.mockResolvedValue({ session: { did: 'did:plc:other' }, state: null });
		client.revoke.mockResolvedValue(undefined);

		expect(await finishGroupLink(params('s1'), ALICE)).toMatchObject({ ok: false });
		expect(client.revoke).toHaveBeenCalledWith('did:plc:other');
	});

	it('reports a refusal at the host as a failed link', async () => {
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		latest().client.callback.mockRejectedValue(new Error('access_denied'));
		expect(await finishGroupLink(params('s1'), ALICE)).toMatchObject({
			ok: false,
			groupDid: GROUP
		});
	});

	it('links the group for the person who started it', async () => {
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		latest().client.callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		expect(await finishGroupLink(params('s1'), ALICE)).toEqual({ ok: true, groupDid: GROUP });
	});

	it('revokes the link it replaces, through a client that holds only that one', async () => {
		const old = { tokenSet: { access_token: 'old' } };
		await sessions.put(`group:session:${ALICE}/${GROUP}`, JSON.stringify(old));
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		const linking = latest();
		linking.client.callback.mockImplementation(async () => {
			// The library stores the new session over the old one.
			await sessions.put(`group:session:${ALICE}/${GROUP}`, JSON.stringify({ new: true }));
			return { session: { did: GROUP }, state: null };
		});
		expect(await finishGroupLink(params('s1'), ALICE)).toEqual({ ok: true, groupDid: GROUP });

		const revoking = latest();
		expect(revoking).not.toBe(linking);
		expect(revoking.client.revoke).toHaveBeenCalledWith(GROUP);
		expect(await revoking.options.stores.sessions.get(GROUP as never)).toEqual(old);
		expect(linking.client.revoke).not.toHaveBeenCalled();
		expect(await sessions.get(`group:session:${ALICE}/${GROUP}`, 'json')).toEqual({ new: true });
	});

	it('keeps the new link when revoking the one it replaced fails', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		latest().client.callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		mocks.revoke.mockRejectedValueOnce(new Error('offline'));
		expect(await finishGroupLink(params('s1'), ALICE)).toEqual({ ok: true, groupDid: GROUP });
		expect(latest().client.revoke).toHaveBeenCalledWith(GROUP);
		expect(console.warn).toHaveBeenCalled();
	});

	it('revokes nothing on a first link, nor when the link fails', async () => {
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		latest().client.callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		await finishGroupLink(params('s1'), ALICE);
		expect(mocks.built).toHaveLength(1);

		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await storedState('s2', { groupDid: GROUP, by: ALICE });
		latest().client.callback.mockRejectedValue(new Error('access_denied'));
		await finishGroupLink(params('s2'), ALICE);
		expect(mocks.built).toHaveLength(1);
	});

	it('notes what the link was approved for, so a link from before the ask grew can be told', async () => {
		expect(await linkAskedCurrentScope(GROUP, ALICE)).toBe(false);
		await storedState('s1', { groupDid: GROUP, by: ALICE });
		await startGroupLink(GROUP, ALICE);
		latest().client.callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		await finishGroupLink(params('s1'), ALICE);
		expect(await sessions.get(`group:asked:${ALICE}/${GROUP}`, 'text')).toBe(GROUP_SESSION_SCOPE);
		expect(await linkAskedCurrentScope(GROUP, ALICE)).toBe(true);
		expect(await linkAskedCurrentScope(GROUP, BOB)).toBe(false);
		await sessions.put(`group:asked:${ALICE}/${GROUP}`, 'atproto');
		expect(await linkAskedCurrentScope(GROUP, ALICE)).toBe(false);
	});
});

describe('linked groups', () => {
	it("lists only the person's own links", async () => {
		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await sessions.put(`group:session:${BOB}/did:plc:other`, '{}');
		await sessions.put('group:state:s1', '{}');
		expect(await linkedGroups(ALICE)).toEqual([GROUP]);
		expect(await linkedGroups(BOB)).toEqual(['did:plc:other']);
	});

	it('forgets a link even when the PDS cannot revoke it', async () => {
		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await sessions.put(`group:asked:${ALICE}/${GROUP}`, GROUP_SESSION_SCOPE);
		await startGroupLink(GROUP, ALICE);
		latest().client.revoke.mockRejectedValue(new Error('offline'));
		await unlinkGroup(GROUP, ALICE);
		expect(sessions.keys()).toEqual([]);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import type { OAuthClientOptions, StoredState } from '@atcute/oauth-node-client';
import { memoryKV, type MemoryKV } from './__fixtures__/kv';

const mocks = vi.hoisted(() => ({
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
		revoke = vi.fn();
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
vi.mock('#lib/atproto/network.js', () => ({ atprotoNetwork: () => undefined }));
vi.mock('@svelte-atproto/oauth/network', () => ({ createActorResolver: () => ({}) }));

import {
	finishGroupSignIn,
	GROUP_SESSION_SCOPE,
	groupClientMetadata,
	groupSignInAvailable,
	linkedGroups,
	startGroupCreate,
	startGroupLink,
	unlinkGroup
} from './sign-in';

const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const GROUP = 'did:plc:group';
const LINK = { groupDid: GROUP, by: ALICE };
const SETTINGS = {
	name: 'Knitters',
	description: null,
	joinPolicy: 'open',
	public: true,
	listed: true
} as const;

let sessions: MemoryKV;
let states: MemoryKV;

/** Each test has its own KV, so the clients it builds are its own; the last is the newest. */
function latest() {
	return mocks.built.at(-1)!;
}

/** A sign-in ALICE started, as its stored state holds it, and the client that will finish it. */
async function started(userState: unknown) {
	const state = { userState, expiresAt: Date.now() + 60_000 } as unknown as StoredState;
	await sessions.put('group:state:s1', JSON.stringify(state));
	await startGroupLink(GROUP, ALICE);
	return latest().client;
}

const finish = (signedIn: string) =>
	finishGroupSignIn(new URLSearchParams({ state: 's1', code: 'c', iss: 'x' }), signedIn);

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
	const scopes = GROUP_SESSION_SCOPE.split(' ');

	it('is its own client, sharing only the library key', () => {
		expect(groupClientMetadata()).toMatchObject({
			client_id: 'https://atmo.example/oauth/group/client-metadata.json',
			redirect_uris: ['https://atmo.example/oauth/group/callback'],
			jwks_uri: 'https://atmo.example/oauth/jwks.json',
			scope: GROUP_SESSION_SCOPE
		});
	});

	it('asks for the meta read as its own scope, and the sets for settings and members', () => {
		expect(scopes).toContain('space:group.opensocial.meta?authority=self&action=read');
		expect(GROUP_SESSION_SCOPE).toContain('group.opensocial.declaration');
		expect(GROUP_SESSION_SCOPE).toContain('community.lexicon.calendar.event');
		expect(scopes.filter((s) => s.startsWith('include:'))).toEqual([
			'include:group.opensocial.configure',
			'include:group.opensocial.manageSpaces',
			'include:group.opensocial.manageMembers'
		]);
	});

	it('asks to make its own spaces, and to write events only in its own calendar space', () => {
		expect(scopes).toContain('space:*?authority=self&manage=create');
		const calendar = scopes.filter((s) => s.startsWith('space:rsvp.atmo.group.calendar?'));
		expect(calendar).toHaveLength(1);
		const params = new URLSearchParams(calendar[0].split('?')[1]);
		expect(params.get('authority')).toBe('self');
		expect(params.getAll('collection')).toEqual(['community.lexicon.calendar.event']);
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
	it('authorizes as the group, notes who started it, and hints the person to the host', async () => {
		const url = await startGroupLink(GROUP, ALICE);
		const { client } = latest();

		expect(client.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { type: 'account', identifier: GROUP },
				state: { groupDid: GROUP, by: ALICE }
			})
		);
		expect(url.searchParams.get('gh_person')).toBe(ALICE);
	});
});

describe('finishGroupSignIn', () => {
	it('refuses a state it does not know', async () => {
		expect(await finish(ALICE)).toMatchObject({ ok: false, groupDid: null });
	});

	it('refuses a browser signed in as someone else, and spends the state', async () => {
		await started(LINK);
		expect(await finish(BOB)).toMatchObject({ ok: false, groupDid: GROUP });
		expect(sessions.keys()).toEqual([]);
		expect(mocks.built.every(({ client }) => client.callback.mock.calls.length === 0)).toBe(true);
	});

	it('revokes a session that is not the group', async () => {
		const client = await started(LINK);
		client.callback.mockResolvedValue({ session: { did: 'did:plc:other' }, state: null });
		client.revoke.mockResolvedValue(undefined);

		expect(await finish(ALICE)).toMatchObject({ ok: false, groupDid: GROUP });
		expect(client.revoke).toHaveBeenCalledWith('did:plc:other');
	});

	it('reports a refusal at the host as a failed link', async () => {
		(await started(LINK)).callback.mockRejectedValue(new Error('access_denied'));
		expect(await finish(ALICE)).toMatchObject({ ok: false, groupDid: GROUP });
	});

	it('links the group for the person who started it', async () => {
		(await started(LINK)).callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		expect(await finish(ALICE)).toEqual({ ok: true, groupDid: GROUP, created: null });
	});
});

describe('linked groups', () => {
	it("lists only the person's own links", async () => {
		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await sessions.put(`group:session:${BOB}/did:plc:other`, '{}');
		await sessions.put('group:state:s1', '{}');
		expect(await linkedGroups(ALICE)).toEqual([GROUP]);
	});

	it('forgets a link even when the PDS cannot revoke it', async () => {
		await sessions.put(`group:session:${ALICE}/${GROUP}`, '{}');
		await startGroupLink(GROUP, ALICE);
		latest().client.revoke.mockRejectedValue(new Error('offline'));
		await unlinkGroup(GROUP, ALICE);
		expect(sessions.keys()).toEqual([]);
	});
});

describe('making a group', () => {
	it("sends the creator to the host's sign-up, with the settings waiting in the state", async () => {
		const url = await startGroupCreate(ALICE, SETTINGS);
		const { client } = latest();
		expect(client.authorize).toHaveBeenCalledWith(
			expect.objectContaining({
				target: { type: 'pds', serviceUrl: 'https://host.example' },
				prompt: 'create',
				state: { create: SETTINGS, by: ALICE }
			})
		);
		expect(url.searchParams.get('gh_name')).toBe('Knitters');
	});

	it('finishes as whatever new group the host made, with its settings', async () => {
		const client = await started({ create: SETTINGS, by: ALICE });
		client.callback.mockResolvedValue({ session: { did: GROUP }, state: null });
		expect(await finish(ALICE)).toEqual({ ok: true, groupDid: GROUP, created: SETTINGS });
	});

	it('refuses a state whose settings do not hold', async () => {
		await started({ create: { ...SETTINGS, name: '' }, by: ALICE });
		expect(await finish(ALICE)).toMatchObject({ ok: false, groupDid: null });
	});
});

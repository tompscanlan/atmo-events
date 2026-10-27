import {
	OAuthClient,
	MemoryStore,
	type ClientAssertionPrivateJwk,
	type OAuthClientStores,
	type OAuthSession,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import { LocalActorResolver } from '@atcute/identity-resolver';
import { KVStore } from './kv-store';
import {
	GROUP_CREATE_REDIRECT_PATH,
	GROUP_LINK_REDIRECT_PATH,
	REDIRECT_PATH,
	scopes
} from '../settings';
import { createDidDocumentResolver, createHandleResolver } from '../identity';
import { DEV_PORT } from '../port';
import { dev } from '$app/environment';

function createActorResolver() {
	return new LocalActorResolver({
		handleResolver: createHandleResolver(),
		didDocumentResolver: createDidDocumentResolver()
	});
}

function createStores(env?: App.Platform['env']): OAuthClientStores {
	if (env?.OAUTH_SESSIONS && env?.OAUTH_STATES) {
		return {
			sessions: new KVStore<Did, StoredSession>(env.OAUTH_SESSIONS),
			states: new KVStore<string, StoredState>(env.OAUTH_STATES, { expirationTtl: 600 })
		};
	}
	// Fallback to in-memory stores (dev without wrangler)
	return {
		sessions: new MemoryStore<Did, StoredSession>(),
		states: new MemoryStore<string, StoredState>({ ttl: 600_000 })
	};
}

let cachedClient: OAuthClient | null = null;
let cachedResolver: LocalActorResolver | null = null;
let cachedStores: OAuthClientStores | null = null;

function sharedResolver(): LocalActorResolver {
	cachedResolver ??= createActorResolver();
	return cachedResolver;
}

/** Shared by every client, so a sign-in started by one client can finish in another. */
function sharedParts(env?: App.Platform['env']) {
	cachedStores ??= createStores(env);
	return { actorResolver: sharedResolver(), stores: cachedStores };
}

/** For a callback that must check who started a flow before the client finishes it. */
export function oauthStates(env?: App.Platform['env']): OAuthClientStores['states'] {
	return sharedParts(env).stores.states;
}

/** A group flow's state finishes only at its own callback, which checks who started it. */
export async function isSignInState(
	env: App.Platform['env'] | undefined,
	stateId: string | null
): Promise<boolean> {
	const stored = stateId ? await oauthStates(env).get(stateId) : undefined;
	return stored !== undefined && new URL(stored.redirectUri).pathname === REDIRECT_PATH;
}

export async function resolveActorDid(identifier: ActorIdentifier): Promise<Did> {
	return (await sharedResolver().resolve(identifier)).did;
}

/** A loopback client carries its scope in its client_id, so the scope cannot grow. */
export function servesClientMetadata(env?: App.Platform['env']): boolean {
	return !(dev && !env?.OAUTH_PUBLIC_URL);
}

/** `extraScopes` go on top of the base scopes; a loopback client ignores them. */
export function createOAuthClient(
	env?: App.Platform['env'],
	extraScopes: readonly string[] = []
): OAuthClient {
	const extras = servesClientMetadata(env) ? extraScopes : [];
	if (cachedClient && extras.length === 0) return cachedClient;

	const { actorResolver, stores } = sharedParts(env);

	if (!servesClientMetadata(env)) {
		cachedClient = new OAuthClient({
			metadata: {
				redirect_uris: [`http://127.0.0.1:${DEV_PORT}${REDIRECT_PATH}`],
				scope: scopes
			},
			actorResolver,
			stores
		});
		return cachedClient;
	}

	const client = confidentialClient(env, extras, stores);
	if (extras.length === 0) cachedClient = client;
	return client;
}

/** Every client declares each redirect path a flow can return to. */
function confidentialClient(
	env: App.Platform['env'] | undefined,
	extras: readonly string[],
	stores: OAuthClientStores
): OAuthClient {
	if (!env?.OAUTH_PUBLIC_URL) {
		throw new Error('OAUTH_PUBLIC_URL is not set');
	}
	if (!env.CLIENT_ASSERTION_KEY) {
		throw new Error('CLIENT_ASSERTION_KEY secret is not set. Run: pnpm env:generate-key');
	}
	const site = env.OAUTH_PUBLIC_URL;
	const key: ClientAssertionPrivateJwk = JSON.parse(env.CLIENT_ASSERTION_KEY);

	return new OAuthClient({
		metadata: {
			client_id: site + '/oauth-client-metadata.json',
			redirect_uris: [
				site + REDIRECT_PATH,
				site + GROUP_LINK_REDIRECT_PATH,
				site + GROUP_CREATE_REDIRECT_PATH
			],
			scope: [...new Set([...scopes, ...extras])],
			jwks_uri: site + '/oauth/jwks.json'
		},
		keyset: [key],
		actorResolver: sharedResolver(),
		stores
	});
}

/** Its sessions are never ones a `did` cookie restores or a sign-in overwrites. */
export function createOAuthClientWithSessions(
	env: App.Platform['env'] | undefined,
	extraScopes: readonly string[],
	sessions: OAuthClientStores['sessions']
): OAuthClient {
	return confidentialClient(env, extraScopes, { sessions, states: oauthStates(env) });
}

export type { OAuthSession };

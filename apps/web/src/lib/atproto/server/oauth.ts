import {
	OAuthClient,
	MemoryStore,
	type ClientAssertionPrivateJwk,
	type OAuthClientStores,
	type OAuthSession,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { LocalActorResolver } from '@atcute/identity-resolver';
import { KVStore } from './kv-store';
import { REDIRECT_PATH, scopes } from '../settings';
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

export function createOAuthClient(env?: App.Platform['env']): OAuthClient {
	if (cachedClient) return cachedClient;

	const actorResolver = createActorResolver();
	const stores = createStores(env);

	if (dev && !env?.OAUTH_PUBLIC_URL) {
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

	if (!env?.OAUTH_PUBLIC_URL) {
		throw new Error('OAUTH_PUBLIC_URL is not set');
	}
	if (!env.CLIENT_ASSERTION_KEY) {
		throw new Error('CLIENT_ASSERTION_KEY secret is not set. Run: pnpm env:generate-key');
	}
	const site = env.OAUTH_PUBLIC_URL;
	const key: ClientAssertionPrivateJwk = JSON.parse(env.CLIENT_ASSERTION_KEY);

	cachedClient = new OAuthClient({
		metadata: {
			client_id: site + '/oauth-client-metadata.json',
			redirect_uris: [site + REDIRECT_PATH],
			scope: scopes,
			jwks_uri: site + '/oauth/jwks.json'
		},
		keyset: [key],
		actorResolver,
		stores
	});
	return cachedClient;
}

export type { OAuthSession };

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
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '@atcute/identity-resolver';
import { KVStore } from './kv-store';
import { DOH_RESOLVER, GROUP_LINK_REDIRECT_PATH, REDIRECT_PATH, scopes } from '../settings';
import { DEV_PORT } from '../port';
import { dev } from '$app/environment';

function createActorResolver() {
	return new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({ dohUrl: DOH_RESOLVER }),
				http: new WellKnownHandleResolver()
			}
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver()
			}
		})
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

/** The store every client keeps its pending authorizations in, for a callback
 *  that must check who started a flow before the client finishes it. */
export function oauthStates(env?: App.Platform['env']): OAuthClientStores['states'] {
	return sharedParts(env).stores.states;
}

/** Resolves a handle or DID to its DID, with the resolver sign-in uses. */
export async function resolveActorDid(identifier: ActorIdentifier): Promise<Did> {
	return (await sharedResolver().resolve(identifier)).did;
}

/** Whether this deployment serves its own client metadata. A loopback client
 *  (dev without OAUTH_PUBLIC_URL) carries its scope inside its client_id, so its
 *  scope cannot grow at sign-in without breaking the callback. */
export function servesClientMetadata(env?: App.Platform['env']): boolean {
	return !(dev && !env?.OAUTH_PUBLIC_URL);
}

/** `extraScopes` are declared on top of the base scopes, for a sign-in that asks
 *  for them and for the metadata route. A client with extras is built fresh each
 *  call, since the set changes as groups are created. A loopback client ignores
 *  them (see `servesClientMetadata`). */
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

/** The deployment's confidential client. Every client it builds declares the same
 *  redirect URIs, so the served metadata lists each path a flow can return to. */
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
			redirect_uris: [site + REDIRECT_PATH, site + GROUP_LINK_REDIRECT_PATH],
			// An extra may repeat a base scope; the metadata lists each once.
			scope: [...new Set([...scopes, ...extras])],
			jwks_uri: site + '/oauth/jwks.json'
		},
		keyset: [key],
		actorResolver: sharedResolver(),
		stores
	});
}

const memorySessions = new Map<string, MemoryStore<Did, StoredSession>>();
const clientsFor = new Map<string, OAuthClient>();

/** A client for sessions that are not sign-ins: the same client_id, metadata and
 *  state store as every other client, with its sessions kept under
 *  `sessionPrefix`. A session it holds is never the one a `did` cookie restores,
 *  and a sign-in under the same DID never overwrites it. Needs this deployment's
 *  own client metadata (see `servesClientMetadata`). */
export function createOAuthClientFor(
	env: App.Platform['env'] | undefined,
	extraScopes: readonly string[],
	sessionPrefix: string
): OAuthClient {
	if (!servesClientMetadata(env)) {
		throw new Error(
			'this deployment serves no client metadata, so it holds no session but a sign-in'
		);
	}
	// Kept per isolate like the sign-in client, so its metadata and DPoP nonce
	// caches survive between requests instead of costing round trips each time.
	const cacheKey = `${sessionPrefix}|${extraScopes.join(' ')}`;
	const cached = clientsFor.get(cacheKey);
	if (cached) return cached;
	let sessions: OAuthClientStores['sessions'];
	if (env?.OAUTH_SESSIONS) {
		sessions = new KVStore<Did, StoredSession>(env.OAUTH_SESSIONS, { prefix: sessionPrefix });
	} else {
		let memory = memorySessions.get(sessionPrefix);
		if (!memory) {
			memory = new MemoryStore<Did, StoredSession>();
			memorySessions.set(sessionPrefix, memory);
		}
		sessions = memory;
	}
	const client = confidentialClient(env, extraScopes, {
		sessions,
		states: sharedParts(env).stores.states
	});
	clientsFor.set(cacheKey, client);
	return client;
}

export type { OAuthSession };

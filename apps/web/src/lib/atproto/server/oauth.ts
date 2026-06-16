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
import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
	XrpcHandleResolver
} from '@atcute/identity-resolver';
import { KVStore } from './kv-store';
import { DOH_RESOLVER, REDIRECT_PATH, scopes, devScopes } from '../settings';
import { DEV_PORT } from '../port';
import { dev } from '$app/environment';
import { env as privateEnv } from '$env/dynamic/private';

function createActorResolver() {
	const plcUrl = privateEnv.PLC_URL;
	const pdsUrl = privateEnv.PDS_URL;

	const handleMethods: Record<string, any> = {
		dns: new DohJsonHandleResolver({ dohUrl: DOH_RESOLVER }),
		http: new WellKnownHandleResolver()
	};
	if (pdsUrl) {
		handleMethods.xrpc = new XrpcHandleResolver({ serviceUrl: pdsUrl });
	}

	return new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({ methods: handleMethods }),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(plcUrl ? { apiUrl: plcUrl } : undefined),
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

export function createOAuthClient(env?: App.Platform['env']): OAuthClient {
	if (cachedClient) return cachedClient;

	const actorResolver = createActorResolver();
	const stores = createStores(env);
	// The granular permission-set scopes (settings.ts `scopes`) require the
	// authorization server to resolve lexicons (e.g. app.bsky.authCreatePosts).
	// A PDS that only advertises transition scopes — like our isolated testnet
	// PDS, which can't resolve lexicons off its own network — rejects the PAR
	// with "Could not resolve Lexicon for NSID". OAUTH_TRANSITION_SCOPES=true
	// makes such a deploy request the legacy transition scopes (the same set
	// dev uses) instead; a public-network deploy leaves it unset for granular.
	const useTransitionScopes = env?.OAUTH_TRANSITION_SCOPES === 'true';
	const effectiveScopes = dev || useTransitionScopes ? devScopes : scopes;

	if (dev && !env?.OAUTH_PUBLIC_URL) {
		cachedClient = new OAuthClient({
			metadata: {
				redirect_uris: [`http://127.0.0.1:${DEV_PORT}${REDIRECT_PATH}`],
				scope: effectiveScopes
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
			scope: effectiveScopes,
			jwks_uri: site + '/oauth/jwks.json'
		},
		keyset: [key],
		actorResolver,
		stores
	});
	return cachedClient;
}

export type { OAuthSession };

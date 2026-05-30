import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons';
import { env as privateEnv } from '$env/dynamic/private';
import type { AuthorityEntry } from './authority-registry';

export type ResolvedAuthority = {
	endpoint: string;
	serviceDid: string;
	namespace: string;
};

const cache = new Map<string, { value: ResolvedAuthority; expiresAt: number }>();
const didDocCache = new Map<string, { value: ResolvedAuthority | null; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

let _didResolver: {
	resolve: (
		did: Did<'plc'> | Did<'web'>
	) => Promise<{ service?: { id: string; serviceEndpoint: { toString(): string } }[] }>;
} | null = null;

function getDidResolver() {
	if (!_didResolver) {
		// Mirror oauth.ts: honor PLC_URL so devnet did:plc resolves against the
		// local PLC instead of the public plc.directory. Without this, communities
		// provisioned on devnet (whose #space_host lives only in local PLC) are
		// never detected and render as ordinary profiles.
		const plcUrl = privateEnv.PLC_URL;
		_didResolver = new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(plcUrl ? { apiUrl: plcUrl } : undefined),
				web: new WebDidDocumentResolver()
			}
		});
	}
	return _didResolver;
}

export async function resolveSpaceHost(
	communityDid: string,
	registry: AuthorityEntry[]
): Promise<ResolvedAuthority> {
	const cached = cache.get(communityDid);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	let result = await resolveFromDidDoc(communityDid, registry);
	if (!result) {
		result = matchEndpointToRegistry(undefined, registry);
	}
	if (!result) {
		throw new Error(
			`Cannot resolve authority for ${communityDid}: no space_host in DID doc and no registry match`
		);
	}

	cache.set(communityDid, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
	return result;
}

export async function resolveSpaceHostFromDidDoc(
	communityDid: string,
	registry: AuthorityEntry[]
): Promise<ResolvedAuthority | null> {
	const cached = didDocCache.get(communityDid);
	if (cached && cached.expiresAt > Date.now()) return cached.value;

	const result = await resolveFromDidDoc(communityDid, registry);
	didDocCache.set(communityDid, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
	return result;
}

async function resolveFromDidDoc(
	communityDid: string,
	registry: AuthorityEntry[]
): Promise<ResolvedAuthority | null> {
	try {
		const doc = await getDidResolver().resolve(communityDid as Did<'plc'> | Did<'web'>);
		if (!doc.service) return null;

		for (const service of doc.service) {
			if (service.id === '#space_host') {
				const endpoint = service.serviceEndpoint.toString();
				const match = matchEndpointToRegistry(endpoint, registry);
				if (match) return match;
				const fallbackNamespace = registry[0]?.namespace;
				if (!fallbackNamespace) {
					throw new Error(
						`space_host endpoint ${endpoint} not in registry and no registry entries to derive namespace`
					);
				}
				return {
					endpoint,
					serviceDid: `did:web:${new URL(endpoint).hostname}`,
					namespace: fallbackNamespace
				};
			}
		}
	} catch {
		// DID resolution failed — fall through to registry scan
	}
	return null;
}

function matchEndpointToRegistry(
	endpoint: string | undefined,
	registry: AuthorityEntry[]
): ResolvedAuthority | null {
	if (endpoint) {
		const match = registry.find((a) => a.endpoint === endpoint);
		if (match)
			return { endpoint: match.endpoint, serviceDid: match.serviceDid, namespace: match.namespace };
	}
	if (registry.length === 1) return { ...registry[0] };
	return null;
}

export function clearCache(): void {
	cache.clear();
	didDocCache.clear();
	_didResolver = null;
}

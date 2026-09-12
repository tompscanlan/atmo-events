/**
 * One origin drives this Worker's whole identity: the public service endpoint,
 * the `did:web` service DID derived from it, and the two fragmented audiences
 * (`#contrail` for the public Contrail API, `#spaces` for the Spaces provider).
 *
 * Contrail refuses to publish `/.well-known/did.json` unless the configured
 * audience resolves its DID document back to the serving origin, so the
 * audiences must be derived from the endpoint rather than hardcoded.
 */

/**
 * Development origin. `.test` is reserved by RFC 6761, so this can never be a
 * real deployment and no production domain is claimed by a committed file;
 * deployments override `PUBLIC_SERVICE_ENDPOINT`.
 *
 * It is HTTPS even for local runs because Contrail's `createWorker` rejects a
 * plain-HTTP public endpoint outright, and a `did:web:localhost%3A<port>`
 * document URL resolves back to HTTP, which its audience check then refuses.
 * `wrangler dev` still serves on http://localhost:8787; only the advertised
 * discovery identity is this origin.
 */
export const DEFAULT_PUBLIC_SERVICE_ENDPOINT = 'https://api.openmeet.test';

export const CONTRAIL_SERVICE_FRAGMENT = 'contrail';
export const SPACES_SERVICE_FRAGMENT = 'spaces';

/** Origins an authority PDS can never call back into. */
const UNREACHABLE_HOSTNAMES: Record<string, true> = {
	localhost: true,
	'127.0.0.1': true,
	'[::1]': true
};

const UNREACHABLE_SUFFIXES = ['.test', '.localhost', '.invalid', '.example'];

/** Resolve the serving origin, rejecting anything that is not a bare origin. */
export function publicServiceEndpoint(env: { PUBLIC_SERVICE_ENDPOINT?: unknown }): string {
	const configured = env.PUBLIC_SERVICE_ENDPOINT;
	if (typeof configured !== 'string' || configured.length === 0) {
		return DEFAULT_PUBLIC_SERVICE_ENDPOINT;
	}
	return new URL(configured).origin;
}

/** `did:web` identity of the endpoint. A port is percent-encoded per did:web. */
export function serviceDid(endpoint: string): `did:web:${string}` {
	const url = new URL(endpoint);
	return `did:web:${url.port ? `${url.hostname}%3A${url.port}` : url.hostname}`;
}

export function serviceAudience(
	endpoint: string,
	fragment: string
): `did:web:${string}#${string}` {
	return `${serviceDid(endpoint)}#${fragment}`;
}

/**
 * Whether an authority PDS could ever reach this origin. Space push
 * registration is pointless for a dev origin; scheduled reconciliation stays
 * authoritative either way.
 */
export function isUnreachableServiceEndpoint(endpoint: string): boolean {
	const { hostname } = new URL(endpoint);
	if (UNREACHABLE_HOSTNAMES[hostname] === true) return true;
	return UNREACHABLE_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

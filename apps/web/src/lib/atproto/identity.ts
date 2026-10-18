import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
	type HandleResolver
} from '@atcute/identity-resolver';
import { network, type NetworkSettings } from './network';

/** How long one handle lookup may wait for an answer. */
export const HANDLE_LOOKUP_MS = 5000;

/**
 * Handle → DID. DNS (over HTTPS) and `.well-known` race, unless the deployment
 * has no DNS resolver (see ./network), when it is `.well-known` alone.
 *
 * Each lookup gives up after `timeoutMs`. A network that drops traffic to hosts
 * outside it (a sealed one) never answers a lookup of an outside handle, and
 * without a limit the sign-in waits until the connection times out, minutes later.
 */
export function createHandleResolver(
	settings: NetworkSettings = network(),
	timeoutMs: number = HANDLE_LOOKUP_MS
): HandleResolver {
	const fetch = fetchWithin(timeoutMs);
	const http = new WellKnownHandleResolver({ fetch });
	if (!settings.dohUrl) return http;
	return new CompositeHandleResolver({
		methods: { dns: new DohJsonHandleResolver({ dohUrl: settings.dohUrl, fetch }), http }
	});
}

/** The global `fetch`, read when called, aborted after `ms` as well as by the
 *  caller's own signal. */
function fetchWithin(ms: number): typeof globalThis.fetch {
	return (input, init) => {
		const limit = AbortSignal.timeout(ms);
		const signal = init?.signal ? AbortSignal.any([init.signal, limit]) : limit;
		return globalThis.fetch(input, { ...init, signal });
	};
}

/**
 * DID → document, from the deployment's directory for did:plc. `fetch` is for a
 * caller that must reach the global `fetch` as it is when the resolver runs.
 */
export function createDidDocumentResolver(
	settings: NetworkSettings = network(),
	fetch?: typeof globalThis.fetch
) {
	return new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver({
				...(settings.plcUrl ? { apiUrl: settings.plcUrl } : {}),
				...(fetch ? { fetch } : {})
			}),
			web: new WebDidDocumentResolver(fetch ? { fetch } : undefined)
		}
	});
}

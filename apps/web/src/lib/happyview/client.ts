import { Client } from '@atcute/client';

/**
 * Read-only @atcute client that forwards rsvp.atmo.* XRPC GETs to a HappyView
 * instance over HTTP. Drop-in for getServerClient's in-process Contrail client:
 * same typed surface, same call sites. Spike only — public read endpoints.
 *
 * HappyView identifies callers for rate-limiting via the `X-Client-Key` header
 * (not a Bearer token); reads are otherwise public.
 */
export function getHappyViewClient(baseUrl: string, clientKey?: string): Client {
	const origin = baseUrl.replace(/\/$/, '');
	return new Client({
		handler: async (pathname, init) => {
			const url = new URL(pathname, origin);
			const headers = new Headers(init?.headers as HeadersInit);
			if (clientKey) headers.set('X-Client-Key', clientKey);
			return fetch(url, { ...init, headers });
		}
	});
}

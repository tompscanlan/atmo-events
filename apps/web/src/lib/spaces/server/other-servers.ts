// Calls to servers other people chose: a guest's PDS, a host's, the domain behind a did:web or a
// handle, and the signed-in person's own PDS when a call goes through their session. A page waits on
// them together, so any one of them could hold it up for everyone.
import type { Client } from '@atcute/client';
import type { AtprotoNetwork } from '@svelte-atproto/oauth/network';
import { waitUntil } from 'cloudflare:workers';
import { atprotoNetwork } from '#lib/atproto/network.js';

/** Time for a small server to wake up. A server past it costs a page this wait, not the page. */
const TIME_LIMIT_MS = 8_000;

// Both calls below take the network's fetch out first. On the public network it is the runtime's own
// fetch, and a built Worker throws "Illegal invocation" if that runs as a method of the network.

/** For a call that carries a token or a signature, so it goes only where it was addressed: never to
 *  a redirect's target, and over https, except on an isolated network, which names its own origins. */
export async function fetchOtherServer(url: URL, init: RequestInit): Promise<Response> {
	const network = atprotoNetwork();
	network.assertUrl(url.href);
	if (!network.isolated && url.protocol !== 'https:') {
		throw new Error(`${url.origin} is not https`);
	}
	const { fetch: send } = network;
	return send(url, {
		...init,
		redirect: 'manual',
		signal: AbortSignal.timeout(TIME_LIMIT_MS)
	});
}

/** This deployment's network with the same time limit, for the library's identity lookups. The
 *  library races DNS against https with a signal of its own, so the limit joins that signal. */
export function timeLimitedNetwork(): AtprotoNetwork {
	const network = atprotoNetwork();
	const { fetch: send } = network;
	return {
		...network,
		fetch: (input, init) => send(input, withTimeLimit(init))
	};
}

/** `init` with the time limit, joined to any signal it already carries so that one still stops it. */
export function withTimeLimit(init?: RequestInit): RequestInit {
	const limit = AbortSignal.timeout(TIME_LIMIT_MS);
	return { ...init, signal: init?.signal ? AbortSignal.any([init.signal, limit]) : limit };
}

/** What `work` settles with, or a timeout once the time limit passes. The work itself goes on. */
export function withinTimeLimit<T>(work: Promise<T>): Promise<T> {
	const limit = AbortSignal.timeout(TIME_LIMIT_MS);
	return new Promise((resolve, reject) => {
		limit.addEventListener('abort', () => reject(limit.reason), { once: true });
		work.then(resolve, reject);
	});
}

/** Each call through a session has the same time limit as a call to anyone else's server, since
 *  a page waits on both. The page stops waiting then, but the call goes on: a token refresh inside
 *  it ignores the signal, since a refresh token works once and the new tokens have to be kept. */
export function withinLimit<T>(
	call: (init: RequestInit) => Promise<T>,
	init: RequestInit
): Promise<T> {
	const limited = withTimeLimit(init);
	const signal = limited.signal as AbortSignal;
	const running = call(limited);
	waitUntil(running.catch(() => {}));
	return new Promise((resolve, reject) => {
		const stop = () => reject(signal.reason);
		if (signal.aborted) return stop();
		signal.addEventListener('abort', stop, { once: true });
		running.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
	});
}

/** The signed-in person's client with the same time limit on each call it makes, for code that
 *  makes calls of its own with it, such as a library's. A signal a call carries still stops it. */
export function timeLimitedClient(client: Client): Client {
	return new Proxy(client, {
		get(target, name) {
			const member = Reflect.get(target, name, target);
			if (typeof member !== 'function') return member;
			if (name !== 'get' && name !== 'post' && name !== 'call') return member.bind(target);
			return (first: unknown, options: { signal?: AbortSignal } = {}) =>
				withinLimit((limited) => member.call(target, first, { ...options, ...limited }), {
					signal: options.signal
				});
		}
	});
}

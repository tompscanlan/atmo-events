import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@atcute/client';
import { fetchOtherServer, timeLimitedClient, timeLimitedNetwork } from './other-servers';

// A network on the public atproto network holds the runtime's own fetch, and on Workers that fetch
// refuses to run as a method of another object. vite dev doesn't refuse, so only a built Worker
// showed this. This stands in for it, held directly, with no wrapper to hide the call.
const runtimeFetch = vi.hoisted(
	() =>
		function (this: unknown, input?: unknown, init?: RequestInit): Promise<Response> {
			if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
			if (String(input).includes('stalled')) {
				return new Promise((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				});
			}
			return Promise.resolve(new Response('answered'));
		}
);
vi.mock('#lib/atproto/network.js', async () => {
	const { createAtprotoNetwork } = await import('@svelte-atproto/oauth/network');
	const network = createAtprotoNetwork({ fetch: runtimeFetch });
	return { atprotoNetwork: () => network };
});

describe('calls to the runtime fetch', () => {
	it('fetchOtherServer gets an answer', async () => {
		const res = await fetchOtherServer(new URL('https://pds.test/xrpc/x'), { method: 'GET' });
		expect(await res.text()).toBe('answered');
	});

	it('the identity lookups get an answer', async () => {
		const res = await timeLimitedNetwork().fetch('https://plc.test/did:plc:abc');
		expect(await res.text()).toBe('answered');
	});

	// The library stops the loser of its DNS and https race this way.
	it('an identity lookup still stops when its own signal does', { timeout: 1000 }, async () => {
		const own = new AbortController();
		const lookup = timeLimitedNetwork().fetch('https://stalled.test/', { signal: own.signal });
		own.abort();
		await expect(lookup).rejects.toBeDefined();
	});
});

describe('the signed-in person’s client with the time limit', () => {
	afterEach(() => vi.restoreAllMocks());

	const stalled = (calls: { signal?: AbortSignal }[]) =>
		({
			get: (_nsid: string, options: { signal?: AbortSignal } = {}) => {
				calls.push(options);
				return new Promise((_resolve, reject) => {
					options.signal?.addEventListener('abort', () => reject(options.signal?.reason));
				});
			},
			post: (_nsid: string, options: { signal?: AbortSignal } = {}) => {
				calls.push(options);
				return new Promise(() => {});
			},
			proxy: 'kept'
		}) as unknown as Client;

	it('stops a read that is not answered in time', { timeout: 1000 }, async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
		const client = timeLimitedClient(stalled([]));
		await expect(client.get('com.atproto.repo.getRecord' as never)).rejects.toMatchObject({
			name: 'TimeoutError'
		});
	});

	it(
		'stops waiting on a write that ignores the signal, and leaves it running',
		{ timeout: 1000 },
		async () => {
			const realTimeout = AbortSignal.timeout.bind(AbortSignal);
			vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
			const client = timeLimitedClient(stalled([]));
			await expect(client.post('com.atproto.repo.putRecord' as never)).rejects.toMatchObject({
				name: 'TimeoutError'
			});
		}
	);

	it('still stops on a signal the call already carries, and passes the rest through', async () => {
		const calls: { signal?: AbortSignal }[] = [];
		const client = timeLimitedClient(stalled(calls));
		const own = new AbortController();
		const call = client.get('com.atproto.repo.getRecord' as never, { signal: own.signal } as never);
		own.abort();
		await expect(call).rejects.toMatchObject({ name: 'AbortError' });
		expect(calls[0]?.signal).not.toBe(own.signal);
		expect((client as unknown as { proxy: string }).proxy).toBe('kept');
	});
});

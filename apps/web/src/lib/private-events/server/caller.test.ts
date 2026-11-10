import { waitUntil } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerSession } from './caller';

/** A session whose PDS never answers. `ignoresSignal` is a token refresh, which runs on whatever
 *  the signal says; otherwise each call waits until its signal stops it. */
function stalledSession({ ignoresSignal = false } = {}) {
	const calls: (RequestInit | undefined)[] = [];
	const session = {
		did: 'did:plc:hosthosthosthosthosthost',
		getTokenInfo: async () => ({ scope: 'atproto' }),
		handle: (_pathname: string, init?: RequestInit) => {
			calls.push(init);
			return new Promise<Response>((_resolve, reject) => {
				if (!ignoresSignal) {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				}
			});
		}
	};
	return { session: session as never, calls };
}

function shortLimit() {
	const realTimeout = AbortSignal.timeout.bind(AbortSignal);
	vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.mocked(waitUntil).mockClear();
});

describe('a call through the person’s own session', () => {
	it('stops when their PDS does not answer in time', { timeout: 1000 }, async () => {
		shortLimit();
		const { session } = stalledSession();
		const caller = await callerSession(session);

		await expect(
			caller!.handle('/xrpc/com.atproto.space.getSpace', { method: 'GET' })
		).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	it(
		'stops waiting on a token refresh, and leaves the refresh running',
		{ timeout: 1000 },
		async () => {
			shortLimit();
			const { session } = stalledSession({ ignoresSignal: true });
			const caller = await callerSession(session);

			await expect(
				caller!.handle('/xrpc/com.atproto.space.getSpace', { method: 'GET' })
			).rejects.toMatchObject({ name: 'TimeoutError' });
			// So the new tokens are still kept once the page has its answer.
			expect(waitUntil).toHaveBeenCalledTimes(1);
		}
	);

	it('still stops on a signal the call already carries', { timeout: 1000 }, async () => {
		const { session, calls } = stalledSession();
		const caller = await callerSession(session);
		const own = new AbortController();

		const call = caller!.handle('/xrpc/com.atproto.space.getSpace', {
			method: 'GET',
			signal: own.signal
		});
		own.abort();

		await expect(call).rejects.toMatchObject({ name: 'AbortError' });
		// The limit is joined to it, not swapped in or left out.
		expect(calls[0]?.signal).toBeDefined();
		expect(calls[0]?.signal).not.toBe(own.signal);
	});
});

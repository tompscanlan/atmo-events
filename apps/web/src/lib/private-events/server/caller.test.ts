import { afterEach, describe, expect, it, vi } from 'vitest';
import { callerSession } from './caller';

/** A session whose PDS never answers: each call waits until its signal stops it. */
function stalledSession() {
	const calls: (RequestInit | undefined)[] = [];
	const session = {
		did: 'did:plc:hosthosthosthosthosthost',
		getTokenInfo: async () => ({ scope: 'atproto' }),
		handle: (_pathname: string, init?: RequestInit) => {
			calls.push(init);
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			});
		}
	};
	return { session: session as never, calls };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe('a call through the person’s own session', () => {
	it('stops when their PDS does not answer in time', { timeout: 1000 }, async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
		const { session } = stalledSession();
		const caller = await callerSession(session);

		await expect(
			caller!.handle('/xrpc/com.atproto.space.getSpace', { method: 'GET' })
		).rejects.toMatchObject({ name: 'TimeoutError' });
	});

	it('still stops on a signal the call already carries', { timeout: 1000 }, async () => {
		const { session, calls } = stalledSession();
		const caller = await callerSession(session);
		const own = new AbortController();

		const call = caller!.handle('/xrpc/com.atproto.space.getSpace', {
			method: 'GET',
			signal: own.signal
		});
		own.abort();

		await expect(call).rejects.toBeDefined();
		expect(calls[0]?.method).toBe('GET');
	});
});

import { OAuthClient } from '@atcute/oauth-node-client';
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

describe('reading the person’s own session', () => {
	it('gives up when the session store does not answer in time', { timeout: 1000 }, async () => {
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(5));
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		const session = {
			did: 'did:plc:hosthosthosthosthosthost',
			getTokenInfo: () => new Promise(() => {})
		};

		await expect(callerSession(session as never)).resolves.toBeNull();
	});
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

describe('a token refresh that finishes after the page has its answer', () => {
	const DID = 'did:plc:hosthosthosthosthosthost';
	const PDS = 'https://pds.example.com';
	const ISSUER = 'https://auth.example.com';
	const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
	const old = {
		iss: ISSUER,
		sub: DID,
		aud: PDS,
		scope: 'atproto',
		access_token: 'old-access',
		refresh_token: 'old-refresh',
		token_type: 'DPoP',
		expires_at: Date.now() - 60_000
	};

	/** The real OAuth client, over a session that has gone stale and a token endpoint that waits to be
	 *  answered; everything it would look up first is already known. */
	async function staleSession() {
		const { privateKey } = await crypto.subtle.generateKey(
			{ name: 'ECDSA', namedCurve: 'P-256' },
			true,
			['sign', 'verify']
		);
		const dpopKey = {
			...(await crypto.subtle.exportKey('jwk', privateKey)),
			alg: 'ES256',
			kid: 'k'
		};
		const stored = new Map<string, unknown>([
			[DID, { dpopKey, authMethod: { method: 'none' }, tokenSet: old }]
		]);
		const saved: unknown[] = [];
		const sessions = {
			get: async (sub: string) => stored.get(sub),
			set: async (sub: string, value: unknown) => {
				saved.push(value);
				stored.set(sub, value);
			},
			delete: async (sub: string) => void stored.delete(sub)
		};
		const asMetadata = {
			issuer: ISSUER,
			authorization_endpoint: `${ISSUER}/oauth/authorize`,
			token_endpoint: TOKEN_ENDPOINT,
			pushed_authorization_request_endpoint: `${ISSUER}/oauth/par`,
			require_pushed_authorization_requests: true,
			response_types_supported: ['code'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			code_challenge_methods_supported: ['S256'],
			token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
			token_endpoint_auth_signing_alg_values_supported: ['ES256'],
			scopes_supported: ['atproto'],
			dpop_signing_alg_values_supported: ['ES256'],
			authorization_response_iss_parameter_supported: true,
			client_id_metadata_document_supported: true
		};
		const prMetadata = { resource: PDS, authorization_servers: [ISSUER] };
		let answer!: (response: Response) => void;
		const tokenRequests: string[] = [];
		const client = new OAuthClient({
			metadata: {
				client_id: 'https://app.example.com/oauth-client-metadata.json',
				redirect_uris: ['https://app.example.com/oauth/callback'],
				scope: 'atproto'
			},
			actorResolver: { resolve: async () => ({ did: DID, handle: 'host.example.com', pds: PDS }) },
			stores: {
				sessions: sessions as never,
				states: {} as never
			},
			fetch: (async (input: Request | URL | string) => {
				const url = String(input instanceof Request ? input.url : input);
				if (url === `${ISSUER}/.well-known/oauth-authorization-server`) {
					return Response.json(asMetadata);
				}
				if (url === `${PDS}/.well-known/oauth-protected-resource`) {
					return Response.json(prMetadata);
				}
				if (url !== TOKEN_ENDPOINT) throw new Error(`unexpected request to ${url}`);
				tokenRequests.push(url);
				return new Promise<Response>((resolve) => (answer = resolve));
			}) as typeof fetch
		});
		const session = await client.restore(DID as never, { refresh: false });
		return {
			session,
			saved,
			tokenRequests,
			answer: (response: Response) => answer(response)
		};
	}

	it('still stores the new tokens', { timeout: 5000 }, async () => {
		// The page's limit runs out once the refresh is waiting on the token endpoint. The session's
		// own 30-second signal is left as it is.
		const limit = new AbortController();
		const realTimeout = AbortSignal.timeout.bind(AbortSignal);
		vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) =>
			ms === 8_000 ? limit.signal : realTimeout(ms)
		);
		const { session, saved, tokenRequests, answer } = await staleSession();
		const caller = await callerSession(session);

		const page = caller!.handle('/xrpc/com.atproto.space.getSpace', { method: 'GET' });
		await vi.waitFor(() => expect(tokenRequests).toHaveLength(1));
		limit.abort(new DOMException('The operation timed out.', 'TimeoutError'));

		await expect(page).rejects.toMatchObject({ name: 'TimeoutError' });
		// The page has its answer, and the refresh is still waiting on the token endpoint.
		expect(saved).toHaveLength(0);

		answer(
			Response.json({
				access_token: 'new-access',
				refresh_token: 'new-refresh',
				token_type: 'DPoP',
				scope: 'atproto',
				sub: DID,
				expires_in: 3600
			})
		);
		await Promise.allSettled(vi.mocked(waitUntil).mock.calls.map(([kept]) => kept));

		expect(saved).toHaveLength(1);
		expect(saved[0]).toMatchObject({
			tokenSet: { access_token: 'new-access', refresh_token: 'new-refresh' }
		});
	});
});

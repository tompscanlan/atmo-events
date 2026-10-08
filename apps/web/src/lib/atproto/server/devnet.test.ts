// Devnet mode signs atmo in against a local atproto devnet: its PDS speaks plain http, and its
// people exist only in its own PLC directory. These tests hold devnet.ts to talking to that
// devnet alone, and hold every other build to the OAuth client it ships with today.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	generateClientAssertionKey,
	MemoryStore,
	OAuthClient,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { ActorIdentifier, Did } from '@atcute/lexicons';
import {
	actorResolver as devnetActorResolver,
	allowHttpOnResolvers,
	refuseHttpsPublicUrl
} from './devnet';

const PLC = 'http://localhost:2592';
const PDS = 'http://localhost:3010';
const DEVNET = { plcUrl: PLC, pdsUrl: PDS };
const OWNER = `did:plc:${'owner'.padEnd(24, '2')}` as Did;
const OWNER_HANDLE = 'owner.devnet.test';
/** bsky.app's DID on the real network, which no devnet PLC directory holds. */
const BSKY_APP = 'did:plc:z72i7hdynmk6r22z27h6tvur' as Did;

/** The flags on an atcute client's two metadata resolvers. atcute keeps both inside the client
 *  and declares them internal, so a test reads them the way devnet.ts sets them. */
function httpFlags(client: OAuthClient) {
	const { resolver } = client as unknown as {
		resolver: Record<
			'protectedResourceResolver' | 'authorizationServerResolver',
			{ allowHttp: boolean }
		>;
	};
	return {
		protectedResource: resolver.protectedResourceResolver.allowHttp,
		authorizationServer: resolver.authorizationServerResolver.allowHttp
	};
}

/** An error's message and every cause's, since atcute wraps the reason it refuses. */
async function rejection(promise: Promise<unknown>): Promise<string> {
	const reason = await promise.then(
		() => undefined,
		(e: unknown) => e
	);
	const messages: string[] = [];
	for (let e = reason; e instanceof Error; e = e.cause) messages.push(e.message);
	if (messages.length === 0) throw new Error('expected a rejection');
	return messages.join(' <- ');
}

function caught(fn: () => unknown): unknown {
	try {
		fn();
	} catch (e) {
		return e;
	}
	throw new Error('expected a throw');
}

/** A devnet on the global fetch: its PDS resolves the handles given, its PLC directory holds
 *  the owner's document, and anything else answers as a devnet that does not know it. Returns
 *  every URL asked, in order. */
function stubDevnet(pdsHandles: Record<string, Did>, ownerPds = PDS): string[] {
	const asked: string[] = [];
	const ownerDoc = {
		'@context': ['https://www.w3.org/ns/did/v1'],
		id: OWNER,
		alsoKnownAs: [`at://${OWNER_HANDLE}`],
		service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: ownerPds }]
	};
	const stub = async (input: RequestInfo | URL) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		asked.push(url.href);
		if (url.origin === PDS && url.pathname === '/xrpc/com.atproto.identity.resolveHandle') {
			const did = pdsHandles[url.searchParams.get('handle') ?? ''];
			if (did) return Response.json({ did });
			return Response.json(
				{ error: 'InvalidRequest', message: 'Unable to resolve handle' },
				{ status: 400 }
			);
		}
		if (url.origin === PLC && decodeURIComponent(url.pathname) === `/${OWNER}`) {
			return Response.json(ownerDoc);
		}
		return Response.json({ message: 'not found' }, { status: 404 });
	};
	vi.stubGlobal('fetch', vi.fn(stub));
	return asked;
}

const origins = (urls: string[]) => [...new Set(urls.map((u) => new URL(u).origin))];

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('devnet mode', () => {
	it('devnet: allowHttp is set on both resolvers of a real OAuth client', async () => {
		const asked: string[] = [];
		const client = new OAuthClient({
			metadata: { redirect_uris: ['http://127.0.0.1:5454/oauth/callback'], scope: 'atproto' },
			actorResolver: devnetActorResolver(DEVNET),
			stores: {
				sessions: new MemoryStore<Did, StoredSession>(),
				states: new MemoryStore<string, StoredState>()
			},
			fetch: async (input) => {
				asked.push(String(input instanceof Request ? input.url : input));
				return new Response('down', { status: 503 });
			}
		});
		const authorizeAtDevnet = () => client.authorize({ target: { type: 'pds', serviceUrl: PDS } });

		// As atcute builds it: the devnet PDS's http metadata is refused without a request.
		expect(httpFlags(client)).toEqual({ protectedResource: false, authorizationServer: false });
		expect(await rejection(authorizeAtDevnet())).toMatch(/http resource not allowed/);
		expect(asked).toEqual([]);

		allowHttpOnResolvers(client);

		// Now both resolvers fetch the devnet's metadata over http.
		expect(httpFlags(client)).toEqual({ protectedResource: true, authorizationServer: true });
		expect(await rejection(authorizeAtDevnet())).toMatch(/unexpected status 503/);
		expect(asked).toEqual([
			`${PDS}/.well-known/oauth-protected-resource`,
			`${PDS}/.well-known/oauth-authorization-server`
		]);
	});

	it('devnet: a client missing the resolver fields is refused by name', () => {
		// An atcute upgrade that renames one of the fields.
		const renamed = {
			resolver: {
				protectedResourceResolver: { allowHttp: false },
				authorizationServerResolver: { allowsHttp: false }
			}
		};
		expect(caught(() => allowHttpOnResolvers(renamed as unknown as OAuthClient))).toMatchObject({
			name: 'DevnetResolverFieldsError',
			message: expect.stringContaining('authorizationServerResolver.allowHttp')
		});
		// Nothing is half set: the field that is there stays off.
		expect(renamed.resolver.protectedResourceResolver.allowHttp).toBe(false);

		expect(caught(() => allowHttpOnResolvers({} as unknown as OAuthClient))).toMatchObject({
			name: 'DevnetResolverFieldsError',
			message: expect.stringContaining('protectedResourceResolver.allowHttp')
		});
	});

	it('devnet: the actor resolver asks only the devnet PLC and PDS', async () => {
		const asked = stubDevnet({ [OWNER_HANDLE]: OWNER });
		const resolver = devnetActorResolver(DEVNET);
		const expected = { did: OWNER, handle: OWNER_HANDLE, pds: `${PDS}/` };

		expect(await resolver.resolve(OWNER_HANDLE as ActorIdentifier)).toEqual(expected);
		expect(await resolver.resolve(OWNER)).toEqual(expected);

		expect(origins(asked).sort()).toEqual([PDS, PLC].sort());
		expect(asked.filter((u) => /plc\.directory|dns-query|cloudflare-dns|^https:/.test(u))).toEqual(
			[]
		);
	});

	it('devnet: a real-network handle is refused before any request leaves for it', async () => {
		// The devnet PDS does not know the handle.
		let asked = stubDevnet({});
		await expect(
			devnetActorResolver(DEVNET).resolve('bsky.app' as ActorIdentifier)
		).rejects.toThrow(/failed to resolve handle/);
		expect(origins(asked)).toEqual([PDS]);

		// The devnet PDS answers with the real DID, which the devnet PLC directory does not hold.
		asked = stubDevnet({ 'bsky.app': BSKY_APP });
		await expect(
			devnetActorResolver(DEVNET).resolve('bsky.app' as ActorIdentifier)
		).rejects.toThrow(/failed to resolve did document/);
		expect(origins(asked).sort()).toEqual([PDS, PLC].sort());

		// A real-network DID, by plc and by web.
		asked = stubDevnet({});
		const resolver = devnetActorResolver(DEVNET);
		await expect(resolver.resolve(BSKY_APP)).rejects.toThrow(/failed to resolve did document/);
		await expect(resolver.resolve('did:web:bsky.app' as Did)).rejects.toThrow(
			/failed to resolve did document/
		);
		expect(origins(asked)).toEqual([PLC]);
	});

	it('devnet: an account whose PDS is off this machine is refused', async () => {
		const asked = stubDevnet({ [OWNER_HANDLE]: OWNER }, 'https://pds.example.com');
		const resolver = devnetActorResolver(DEVNET);

		await expect(resolver.resolve(OWNER)).rejects.toThrow(
			`${OWNER} is hosted at https://pds.example.com/, which is off this machine`
		);
		await expect(resolver.resolve(OWNER_HANDLE as ActorIdentifier)).rejects.toThrow(
			/off this machine/
		);
		expect(origins(asked).sort()).toEqual([PDS, PLC].sort());
	});

	it('devnet: an https OAUTH_PUBLIC_URL is refused', () => {
		for (const site of ['https://atmo.rsvp', 'HTTPS://atmo.example.com/']) {
			expect(() => refuseHttpsPublicUrl(site)).toThrow(/https/);
		}
		for (const local of [undefined, '', 'http://127.0.0.1:5454']) {
			expect(() => refuseHttpsPublicUrl(local)).not.toThrow();
		}
	});
});

describe('every other build', () => {
	it('outside devnet mode, the OAuth client keeps allowHttp off and its confidential metadata unchanged', async () => {
		// vite.config.ts defines the flag only in devnet mode, so it is undefined here, as in a
		// production build.
		expect(import.meta.env.DEVNET).toBeUndefined();

		const site = 'https://atmo.example.com';
		const env = {
			OAUTH_PUBLIC_URL: site,
			CLIENT_ASSERTION_KEY: JSON.stringify(await generateClientAssertionKey('test-key'))
		} as unknown as App.Platform['env'];

		vi.resetModules();
		const confidential = (await import('./oauth')).createOAuthClient(env);
		expect(httpFlags(confidential)).toEqual({
			protectedResource: false,
			authorizationServer: false
		});
		// As served, and as the base build served it.
		expect(JSON.parse(JSON.stringify(confidential.metadata))).toStrictEqual({
			client_id: `${site}/oauth-client-metadata.json`,
			redirect_uris: [`${site}/oauth/callback`, `${site}/oauth/group-link/callback`],
			scope:
				'atproto repo?collection=community.lexicon.calendar.event&collection=community.lexicon.calendar.rsvp ' +
				'blob?accept=image/* include:rsvp.atmo.permissionSet include:app.bsky.authCreatePosts ' +
				'rpc?lxm=pub.atmo.notify.requestPermission&aud=* rpc?lxm=pub.atmo.notify.revokeSelf&aud=*',
			application_type: 'web',
			subject_type: 'public',
			response_types: ['code'],
			grant_types: ['authorization_code', 'refresh_token'],
			token_endpoint_auth_method: 'private_key_jwt',
			token_endpoint_auth_signing_alg: 'ES256',
			dpop_bound_access_tokens: true,
			jwks_uri: `${site}/oauth/jwks.json`
		});

		// The loopback client a dev server without OAUTH_PUBLIC_URL signs in with.
		vi.resetModules();
		const loopback = (await import('./oauth')).createOAuthClient(undefined);
		expect(httpFlags(loopback)).toEqual({ protectedResource: false, authorizationServer: false });
		expect(loopback.metadata.client_id).toMatch(/^http:\/\/localhost\?/);
	});
});

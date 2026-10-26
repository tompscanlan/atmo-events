import { describe, expect, it } from 'vitest';
import { imageUrl, readNetwork } from './network';
import { contrailNetwork } from './contrail-network';
import { createDidDocumentResolver, createHandleResolver } from './identity';
import {
	DEFAULT_APPVIEW_URL,
	DEFAULT_IMAGE_URL_TEMPLATE,
	configureAtproto,
	getAppviewUrl,
	getCDNImageBlobUrl
} from '../../../../../packages/ui/src/atproto-helpers';

const localNetwork = {
	PUBLIC_PLC_URL: 'https://plc.example.com/',
	PUBLIC_SLINGSHOT_URL: 'https://slingshot.example.com',
	PUBLIC_JETSTREAM_URLS: 'wss://jetstream.example.com',
	PUBLIC_RELAY_URLS: 'https://relay.example.com',
	PUBLIC_CONSTELLATION_URL: 'https://constellation.example.com',
	PUBLIC_SIGNUP_PDS_URL: 'https://pds.example.com',
	PUBLIC_DOH_URL: 'https://dns.example.com/dns-query',
	PUBLIC_BSKY_APPVIEW_URL: 'https://appview.example.com',
	PUBLIC_TYPEAHEAD_URL: 'https://typeahead.example.com',
	PUBLIC_UFOS_URL: 'https://ufos.example.com',
	PUBLIC_IMAGE_URL_TEMPLATE:
		'https://pds.example.com/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}'
};

describe('readNetwork', () => {
	it('is the public network when nothing is set', () => {
		const n = readNetwork({});
		expect(n.plcUrl).toBeUndefined();
		expect(n.slingshotUrl).toBeUndefined();
		expect(n.jetstreams).toBeUndefined();
		expect(n.relays).toBeUndefined();
		expect(n.constellationUrl).toBeUndefined();
		expect(n.signUpPdsUrl).toBeUndefined();
		expect(n.dohUrl).toBe('https://mozilla.cloudflare-dns.com/dns-query');
		expect(n.appviewUrl).toBe('https://public.api.bsky.app');
		expect(n.typeaheadUrl).toBe('https://typeahead.waow.tech');
		expect(n.ufosUrl).toBe('https://ufos-api.microcosm.blue');
	});

	it('treats blank values as unset', () => {
		expect(readNetwork({ PUBLIC_PLC_URL: '  ' }).plcUrl).toBeUndefined();
	});

	it('takes each address as given, without a trailing slash', () => {
		const n = readNetwork({
			PUBLIC_PLC_URL: 'https://plc.example.test/',
			PUBLIC_JETSTREAM_URLS: 'wss://a.example.test, wss://b.example.test'
		});
		expect(n.plcUrl).toBe('https://plc.example.test');
		expect(n.jetstreams).toEqual(['wss://a.example.test', 'wss://b.example.test']);
	});

	it('rejects an address that is not a URL', () => {
		expect(() => readNetwork({ PUBLIC_PLC_URL: 'plc' })).toThrow(/PUBLIC_PLC_URL is not a URL/);
	});

	it('reads every address from its own setting', () => {
		expect(readNetwork(localNetwork)).toEqual({
			plcUrl: 'https://plc.example.com',
			slingshotUrl: 'https://slingshot.example.com',
			jetstreams: ['wss://jetstream.example.com'],
			relays: ['https://relay.example.com'],
			constellationUrl: 'https://constellation.example.com',
			signUpPdsUrl: 'https://pds.example.com',
			dohUrl: 'https://dns.example.com/dns-query',
			appviewUrl: 'https://appview.example.com',
			typeaheadUrl: 'https://typeahead.example.com',
			ufosUrl: 'https://ufos.example.com',
			imageUrlTemplate: 'https://pds.example.com/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}'
		});
	});
});

describe('imageUrl', () => {
	it('is the Bluesky image URL by default', () => {
		expect(imageUrl('did:plc:abc', 'bafk', 'webp', readNetwork({}))).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@webp'
		);
		expect(imageUrl('did:plc:abc', 'bafk', 'jpeg', readNetwork({}))).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@jpeg'
		);
	});

	it("is the network's own when it has a template", () => {
		expect(imageUrl('did:plc:abc', 'bafk', 'webp', readNetwork(localNetwork))).toBe(
			'https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did:plc:abc&cid=bafk'
		);
	});
});

describe('contrailNetwork', () => {
	it('leaves contrail on its defaults when nothing is set', () => {
		expect(contrailNetwork(readNetwork({}))).toEqual({});
	});

	it('points contrail at the network', () => {
		const c = contrailNetwork(readNetwork(localNetwork));
		expect(c.jetstreams).toEqual(['wss://jetstream.example.com']);
		expect(c.relays).toEqual(['https://relay.example.com']);
		expect(c.constellation).toEqual({ url: 'https://constellation.example.com' });
		expect(c.networkOverrides?.slingshotUrl).toBe(
			'https://slingshot.example.com/xrpc/com.bad-example.identity.resolveMiniDoc'
		);
		expect(c.networkOverrides?.resolver).toBeDefined();
	});
});

describe('resolvers', () => {
	it('asks only the addresses it is given', async () => {
		const asked: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			asked.push(String(input instanceof Request ? input.url : input));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		try {
			const settings = readNetwork(localNetwork);
			await createDidDocumentResolver(settings)
				.resolve('did:plc:abcdefghijklmnopqrstuvwx')
				.catch(() => undefined);
			await createHandleResolver(settings)
				.resolve('ana.example.com')
				.catch(() => undefined);
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.filter((u) => !u.includes('example.com'))).toEqual([]);
		expect(asked.some((u) => u.startsWith('https://plc.example.com/'))).toBe(true);
		expect(asked.some((u) => u.includes('/.well-known/atproto-did'))).toBe(true);
	});

	it('gives up on a handle lookup that never answers', async () => {
		const realFetch = globalThis.fetch;
		globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
			})) as typeof fetch;
		try {
			const started = Date.now();
			await expect(
				createHandleResolver(readNetwork(localNetwork), 50).resolve('bsky.app')
			).rejects.toBeDefined();
			expect(Date.now() - started).toBeLessThan(2000);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	it('looks up a handle where AbortSignal.any is missing', async () => {
		const any = AbortSignal.any;
		const asked: string[] = [];
		const realFetch = globalThis.fetch;
		Reflect.deleteProperty(AbortSignal, 'any');
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			asked.push(String(input instanceof Request ? input.url : input));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		try {
			await createHandleResolver(readNetwork({}))
				.resolve('ana.example.com')
				.catch(() => undefined);
		} finally {
			AbortSignal.any = any;
			globalThis.fetch = realFetch;
		}
		expect(asked.length).toBeGreaterThan(0);
	});

	it('asks the public directory by default', async () => {
		const asked: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			asked.push(String(input instanceof Request ? input.url : input));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		try {
			await createDidDocumentResolver(readNetwork({}))
				.resolve('did:plc:abcdefghijklmnopqrstuvwx')
				.catch(() => undefined);
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(asked[0]).toMatch(/^https:\/\/plc\.directory\//);
	});
});

describe('the shared components', () => {
	const blob = { $type: 'blob' as const, ref: { $link: 'bafk' } };

	it('default to the same public addresses as the app', () => {
		const n = readNetwork({});
		expect(DEFAULT_IMAGE_URL_TEMPLATE).toBe(n.imageUrlTemplate);
		expect(DEFAULT_APPVIEW_URL).toBe(n.appviewUrl);
		expect(getCDNImageBlobUrl({ did: 'did:plc:abc', blob })).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@webp'
		);
	});

	it('follow the network they are configured with', () => {
		const n = readNetwork(localNetwork);
		try {
			configureAtproto({ imageUrlTemplate: n.imageUrlTemplate, appviewUrl: n.appviewUrl });
			expect(getCDNImageBlobUrl({ did: 'did:plc:abc', blob })).toBe(
				'https://pds.example.com/xrpc/com.atproto.sync.getBlob?did=did:plc:abc&cid=bafk'
			);
			expect(getAppviewUrl()).toBe('https://appview.example.com');
		} finally {
			configureAtproto({
				imageUrlTemplate: DEFAULT_IMAGE_URL_TEMPLATE,
				appviewUrl: DEFAULT_APPVIEW_URL
			});
		}
	});
});

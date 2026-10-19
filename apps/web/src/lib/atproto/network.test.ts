import { describe, expect, it } from 'vitest';
import { blobUrl, readNetwork } from './network';
import { contrailNetwork } from './contrail-network';
import { createDidDocumentResolver, createHandleResolver } from './identity';
import {
	DEFAULT_APPVIEW_URL,
	DEFAULT_BLOB_URL_TEMPLATE,
	configureAtproto,
	getAppviewUrl,
	getCDNImageBlobUrl
} from '../../../../../packages/ui/src/atproto-helpers';

const globe = {
	PUBLIC_ATPROTO_SEALED: 'true',
	PUBLIC_ATPROTO_PLC_URL: 'https://plc.lighthouse.snowglobe.at/',
	PUBLIC_ATPROTO_SLINGSHOT_URL: 'https://slingshot.lighthouse.snowglobe.at',
	PUBLIC_ATPROTO_JETSTREAM_URLS: 'wss://jetstream.lighthouse.snowglobe.at',
	PUBLIC_ATPROTO_RELAY_URLS: 'https://relay.lighthouse.snowglobe.at',
	PUBLIC_ATPROTO_SIGNUP_PDS: 'https://pds.lighthouse.snowglobe.at',
	PUBLIC_ATPROTO_BLOB_URL_TEMPLATE:
		'https://pds.lighthouse.snowglobe.at/xrpc/com.atproto.sync.getBlob?did={did}&cid={cid}'
};

describe('readNetwork', () => {
	it('is the public network when nothing is set', () => {
		const n = readNetwork({});
		expect(n.sealed).toBe(false);
		expect(n.plcUrl).toBeUndefined();
		expect(n.slingshotUrl).toBeUndefined();
		expect(n.jetstreams).toBeUndefined();
		expect(n.relays).toBeUndefined();
		expect(n.constellationUrl).toBeUndefined();
		expect(n.signUpPds).toBeUndefined();
		expect(n.dohUrl).toBe('https://mozilla.cloudflare-dns.com/dns-query');
		expect(n.appviewUrl).toBe('https://public.api.bsky.app');
		expect(n.typeaheadUrl).toBe('https://typeahead.waow.tech');
		expect(n.statsUrl).toBe('https://ufos-api.microcosm.blue');
		expect(n.pdslsUrl).toBe('https://pds.ls');
	});

	it('treats blank values as unset', () => {
		expect(readNetwork({ PUBLIC_ATPROTO_PLC_URL: '  ' }).plcUrl).toBeUndefined();
	});

	it('takes each address as given, without a trailing slash', () => {
		const n = readNetwork({
			PUBLIC_ATPROTO_PLC_URL: 'https://plc.example.test/',
			PUBLIC_ATPROTO_JETSTREAM_URLS: 'wss://a.example.test, wss://b.example.test'
		});
		expect(n.plcUrl).toBe('https://plc.example.test');
		expect(n.jetstreams).toEqual(['wss://a.example.test', 'wss://b.example.test']);
	});

	it('rejects an address that is not a URL', () => {
		expect(() => readNetwork({ PUBLIC_ATPROTO_PLC_URL: 'plc' })).toThrow(/PLC_URL is not a URL/);
	});

	it('turns the services a private network has no stand-in for off when sealed', () => {
		const n = readNetwork(globe);
		expect(n.dohUrl).toBeNull();
		expect(n.appviewUrl).toBeNull();
		expect(n.typeaheadUrl).toBeNull();
		expect(n.statsUrl).toBeNull();
		expect(n.constellationUrl).toBeNull();
		expect(n.pdslsUrl).toBeNull();
	});

	it('lets a sealed network name its own stand-in for those services', () => {
		const n = readNetwork({
			...globe,
			PUBLIC_ATPROTO_APPVIEW_URL: 'https://appview.lighthouse.snowglobe.at'
		});
		expect(n.appviewUrl).toBe('https://appview.lighthouse.snowglobe.at');
		expect(
			readNetwork({ ...globe, PUBLIC_ATPROTO_PDSLS_URL: 'https://pdsls.lighthouse.snowglobe.at/' })
				.pdslsUrl
		).toBe('https://pdsls.lighthouse.snowglobe.at');
	});

	it('refuses to fall back when sealed and an address is missing', () => {
		for (const key of Object.keys(globe).filter((k) => k !== 'PUBLIC_ATPROTO_SEALED')) {
			const rest = Object.fromEntries(Object.entries(globe).filter(([k]) => k !== key));
			expect(() => readNetwork(rest), key).toThrow(key);
		}
	});
});

describe('blobUrl', () => {
	it('is the Bluesky image URL by default', () => {
		expect(blobUrl('did:plc:abc', 'bafk', 'webp', readNetwork({}))).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@webp'
		);
		expect(blobUrl('did:plc:abc', 'bafk', 'jpeg', readNetwork({}))).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@jpeg'
		);
	});

	it("is the network's own when it has a template", () => {
		expect(blobUrl('did:plc:abc', 'bafk', 'webp', readNetwork(globe))).toBe(
			'https://pds.lighthouse.snowglobe.at/xrpc/com.atproto.sync.getBlob?did=did:plc:abc&cid=bafk'
		);
	});
});

describe('contrailNetwork', () => {
	it('leaves contrail on its defaults when nothing is set', () => {
		expect(contrailNetwork(readNetwork({}))).toEqual({});
	});

	it('points contrail at the network, and turns Constellation off', () => {
		const c = contrailNetwork(readNetwork(globe));
		expect(c.jetstreams).toEqual(['wss://jetstream.lighthouse.snowglobe.at']);
		expect(c.relays).toEqual(['https://relay.lighthouse.snowglobe.at']);
		expect(c.constellation).toBe(false);
		// Contrail takes the lookup method's URL and adds ?identifier= to it.
		expect(c.networkOverrides?.slingshotUrl).toBe(
			'https://slingshot.lighthouse.snowglobe.at/xrpc/com.bad-example.identity.resolveMiniDoc'
		);
		expect(c.networkOverrides?.resolver).toBeDefined();
	});
});

describe('resolvers', () => {
	it('asks the network directory, and nothing public, when sealed', async () => {
		const asked: string[] = [];
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			asked.push(String(input instanceof Request ? input.url : input));
			return new Response('{}', { status: 404 });
		}) as typeof fetch;
		try {
			const settings = readNetwork(globe);
			await createDidDocumentResolver(settings)
				.resolve('did:plc:abcdefghijklmnopqrstuvwx')
				.catch(() => undefined);
			await createHandleResolver(settings)
				.resolve('ana.lighthouse.snowglobe.at')
				.catch(() => undefined);
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(asked.length).toBeGreaterThan(0);
		expect(asked.filter((u) => !u.includes('lighthouse.snowglobe.at'))).toEqual([]);
		expect(asked.some((u) => u.startsWith('https://plc.lighthouse.snowglobe.at/'))).toBe(true);
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
				createHandleResolver(readNetwork(globe), 50).resolve('bsky.app')
			).rejects.toBeDefined();
			expect(Date.now() - started).toBeLessThan(2000);
		} finally {
			globalThis.fetch = realFetch;
		}
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
		expect(DEFAULT_BLOB_URL_TEMPLATE).toBe(n.blobUrlTemplate);
		expect(DEFAULT_APPVIEW_URL).toBe(n.appviewUrl);
		expect(getCDNImageBlobUrl({ did: 'did:plc:abc', blob })).toBe(
			'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/bafk@webp'
		);
	});

	it('follow the network they are configured with', () => {
		const n = readNetwork(globe);
		try {
			configureAtproto({ blobUrlTemplate: n.blobUrlTemplate, appviewUrl: n.appviewUrl });
			expect(getCDNImageBlobUrl({ did: 'did:plc:abc', blob })).toBe(
				'https://pds.lighthouse.snowglobe.at/xrpc/com.atproto.sync.getBlob?did=did:plc:abc&cid=bafk'
			);
			expect(getAppviewUrl()).toBeNull();
		} finally {
			configureAtproto({
				blobUrlTemplate: DEFAULT_BLOB_URL_TEMPLATE,
				appviewUrl: DEFAULT_APPVIEW_URL
			});
		}
	});
});

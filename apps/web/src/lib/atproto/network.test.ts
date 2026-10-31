import { afterEach, describe, expect, it, vi } from 'vitest';
import { variables } from '../../env';

afterEach(() => {
	vi.doUnmock('$app/env/public');
	vi.resetModules();
	vi.unstubAllGlobals();
});

/** The network module, as a deployment with these settings sees it. */
async function withSettings(settings: Record<string, unknown>) {
	vi.resetModules();
	const unset = Object.fromEntries(Object.keys(variables).map((name) => [name, undefined]));
	vi.doMock('$app/env/public', () => ({ ...unset, ...settings }));
	return import('./network');
}

function validate(name: keyof typeof variables, value: string | undefined) {
	return variables[name].schema['~standard'].validate(value);
}

describe('network settings', () => {
	it('are optional: unset or blank leaves the default', () => {
		for (const name of Object.keys(variables) as (keyof typeof variables)[]) {
			expect(validate(name, undefined)).toEqual({ value: undefined });
			expect(validate(name, '  ')).toEqual({ value: undefined });
		}
	});

	it.each([
		['PUBLIC_PLC_URL', ' https://plc.test ', 'https://plc.test'],
		['PUBLIC_DOH_URL', 'https://dns.test/dns-query', 'https://dns.test/dns-query'],
		['PUBLIC_JETSTREAM_URL', 'wss://jetstream.test', 'wss://jetstream.test'],
		['PUBLIC_JETSTREAM_URL', 'wss://jetstream.test/', 'wss://jetstream.test/'],
		['PUBLIC_JETSTREAM_URL', 'https://jetstream.test', 'https://jetstream.test'],
		['PUBLIC_RELAY_URLS', 'https://a.test, https://b.test,', ['https://a.test', 'https://b.test']]
	] as const)(
		'take a URL of the service’s scheme, Jetstream as an origin, relays as a list: %s %j',
		(name, value, expected) => {
			expect(validate(name, value)).toEqual({ value: expected });
		}
	);

	it.each([
		['a bare host', 'PUBLIC_PLC_URL', 'plc.test'],
		['another service’s scheme', 'PUBLIC_PLC_URL', 'wss://plc.test'],
		['a scheme neither HTTP nor WebSocket', 'PUBLIC_JETSTREAM_URL', 'ftp://jetstream.test'],
		['a #fragment', 'PUBLIC_PLC_URL', 'https://plc.test/#top'],
		['a user and password', 'PUBLIC_PLC_URL', 'https://me:pw@plc.test'],
		['a Jetstream path', 'PUBLIC_JETSTREAM_URL', 'wss://jetstream.test/subscribe'],
		['a Jetstream query', 'PUBLIC_JETSTREAM_URL', 'wss://jetstream.test?compress=true'],
		['a relay that is not a URL', 'PUBLIC_RELAY_URLS', 'https://a.test,b.test']
	] as const)('refuse %s: %s set to %j', (_why, name, value) => {
		expect(validate(name, value)).toHaveProperty('issues');
	});
});

describe('atprotoNetwork', () => {
	it('is the public network when nothing is set', async () => {
		const { atprotoNetwork, serviceUrl } = await withSettings({});
		expect(atprotoNetwork()).toBe(atprotoNetwork());
		expect(atprotoNetwork().isolated).toBe(false);
		expect(serviceUrl('plc')).toBe('https://plc.directory');
		expect(serviceUrl('appview')).toBe('https://public.api.bsky.app');
		expect(serviceUrl('cdn')).toBe('https://cdn.bsky.app');
	});

	it('uses each address a setting names', async () => {
		const { atprotoNetwork, serviceUrl } = await withSettings({
			PUBLIC_PLC_URL: 'https://plc.test/',
			PUBLIC_DOH_URL: 'https://dns.test/dns-query',
			PUBLIC_SLINGSHOT_URL: 'https://slingshot.test',
			PUBLIC_CONSTELLATION_URL: 'https://constellation.test',
			PUBLIC_APPVIEW_URL: 'https://appview.test',
			PUBLIC_CDN_URL: 'https://cdn.test'
		});
		expect(atprotoNetwork().identity).toMatchObject({
			plc: 'https://plc.test/',
			doh: 'https://dns.test/dns-query'
		});
		expect(serviceUrl('plc')).toBe('https://plc.test');
		expect(serviceUrl('slingshot')).toBe('https://slingshot.test');
		expect(serviceUrl('constellation')).toBe('https://constellation.test');
		expect(serviceUrl('appview')).toBe('https://appview.test');
		expect(serviceUrl('cdn')).toBe('https://cdn.test');
		// Not set, so still the public network's.
		expect(serviceUrl('ufo')).toBe('https://ufos-api.microcosm.blue');
	});
});

describe('contrailNetwork', () => {
	it('leaves contrail on its defaults when nothing is set', async () => {
		const { contrailNetwork } = await withSettings({});
		expect(contrailNetwork()).toEqual({ networkOverrides: {} });
	});

	it('gives contrail the same addresses', async () => {
		const { contrailNetwork } = await withSettings({
			PUBLIC_PLC_URL: 'https://plc.test',
			PUBLIC_SLINGSHOT_URL: 'https://slingshot.test/',
			PUBLIC_CONSTELLATION_URL: 'https://constellation.test',
			PUBLIC_JETSTREAM_URL: 'wss://jetstream.test',
			PUBLIC_RELAY_URLS: ['https://relay.test']
		});
		expect(contrailNetwork()).toMatchObject({
			jetstreams: ['wss://jetstream.test'],
			relays: ['https://relay.test'],
			constellation: { url: 'https://constellation.test' },
			networkOverrides: {
				// The method's URL, since contrail only appends ?identifier=.
				slingshotUrl: 'https://slingshot.test/xrpc/com.bad-example.identity.resolveMiniDoc',
				resolver: expect.anything()
			}
		});
	});

	it('resolves did:plc documents at the PLC directory a setting names', async () => {
		const fetch = vi.fn(async () => new Response('{}', { status: 404 }));
		vi.stubGlobal('fetch', fetch);
		const { contrailNetwork } = await withSettings({ PUBLIC_PLC_URL: 'https://plc.test' });
		await contrailNetwork()
			.networkOverrides?.resolver?.resolve('did:plc:abcdefghijklmnopqrstuvwx')
			.catch(() => {});
		expect(new URL(String((fetch.mock.calls[0] as unknown[])[0])).origin).toBe('https://plc.test');
	});
});

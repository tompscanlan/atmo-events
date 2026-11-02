import { describe, expect, it } from 'vitest';
import { config as appConfig } from '../contrail.config';
import { config, networkSettingsFrom } from './cli.config';

describe('the config contrail’s CLI loads', () => {
	it('is the app’s config on contrail’s defaults when no network is set', () => {
		expect(config({})).toEqual({ ...appConfig, networkOverrides: {} });
	});

	it('reads the network its env names', () => {
		const cli = config({
			PUBLIC_RELAY_URLS: 'http://relay.test, http://relay2.test',
			PUBLIC_JETSTREAM_URL: 'ws://jetstream.test',
			PUBLIC_SLINGSHOT_URL: 'http://slingshot.test',
			PUBLIC_CONSTELLATION_URL: 'http://constellation.test',
			PUBLIC_PLC_URL: 'http://plc.test'
		});
		expect(cli).toMatchObject({
			relays: ['http://relay.test', 'http://relay2.test'],
			jetstreams: ['ws://jetstream.test'],
			constellation: { url: 'http://constellation.test' },
			networkOverrides: {
				slingshotUrl: 'http://slingshot.test/xrpc/com.bad-example.identity.resolveMiniDoc'
			}
		});
		expect(cli.networkOverrides?.resolver).toBeDefined();
	});

	it('refuses a setting src/env.ts refuses, naming it', () => {
		expect(() => config({ PUBLIC_PLC_URL: 'plc.test' })).toThrow(/^PUBLIC_PLC_URL: /);
	});

	it('ignores env values that are not text, such as bindings', () => {
		expect(networkSettingsFrom({ PUBLIC_RELAY_URLS: { prepare() {} } })).toMatchObject({
			PUBLIC_RELAY_URLS: undefined
		});
	});
});

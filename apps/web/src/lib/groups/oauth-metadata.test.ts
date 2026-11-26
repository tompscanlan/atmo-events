import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AtprotoAuthConfig } from '@svelte-atproto/oauth/server';
import { scopes } from '#lib/atproto/settings.js';
import { BETA_SCOPE } from '#lib/private-events/beta.js';
import { HOST_SCOPES } from '#lib/private-events/scopes.js';

const mocks = vi.hoisted(() => ({
	create: vi.fn<(config: AtprotoAuthConfig) => unknown>(() => ({ api: {}, handlers: {} }))
}));
vi.mock('@svelte-atproto/oauth/server', () => ({ createAtprotoAuth: mocks.create }));

/** The scope a person's client metadata declares, with these settings. */
async function declared(settings: { groupHost?: string; privateEvents?: string }) {
	// A fresh module each time: the auth is made once per isolate.
	vi.resetModules();
	mocks.create.mockClear();
	const { env } = await import('cloudflare:workers');
	Object.assign(env, {
		OAUTH_PUBLIC_URL: 'https://atmo.example',
		COOKIE_SECRET: 'secret',
		CLIENT_ASSERTION_KEY: 'private-key',
		GROUP_HOST_URL: settings.groupHost,
		PRIVATE_EVENTS: settings.privateEvents
	});
	const { getAuth } = await import('#lib/atproto/server/oauth.js');
	getAuth();
	return (mocks.create.mock.calls[0][0] as AtprotoAuthConfig).scope;
}

afterEach(async () => {
	const { env } = await import('cloudflare:workers');
	Reflect.deleteProperty(env, 'GROUP_HOST_URL');
	Reflect.deleteProperty(env, 'PRIVATE_EVENTS');
});

describe("a person's sign-in permissions, with groups", () => {
	it("are exactly main's with groups off, as a blank group host leaves them", async () => {
		expect(await declared({})).toEqual(scopes);
		expect(await declared({ groupHost: '  ' })).toEqual(scopes);
		expect(await declared({ privateEvents: 'true' })).toEqual([
			...scopes,
			...HOST_SCOPES,
			BETA_SCOPE
		]);
	});

	it('add making a group, the participate set and "your groups" with groups on', async () => {
		const groups = [
			'rpc:org.atgrp.internal.createGroup?aud=*',
			'include:org.atgrp.authParticipate',
			'rpc:org.atgrp.internal.getActorGroups?aud=*'
		];
		expect(await declared({ groupHost: 'https://host.example' })).toEqual([...scopes, ...groups]);
		expect(await declared({ groupHost: 'https://host.example', privateEvents: 'true' })).toEqual([
			...scopes,
			...HOST_SCOPES,
			BETA_SCOPE,
			...groups
		]);
	});
});

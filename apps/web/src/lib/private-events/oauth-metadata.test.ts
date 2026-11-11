import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtprotoAuthConfig } from '@svelte-atproto/oauth/server';
import { scopes } from '#lib/atproto/settings.js';
import { BETA_SCOPE } from './beta';
import { INBOX_OWNER_SCOPE, INVITER_SCOPE, privateEventScopes } from './scopes';

const mocks = vi.hoisted(() => ({
	create: vi.fn<(config: AtprotoAuthConfig) => unknown>(() => ({ api: {}, handlers: {} }))
}));
vi.mock('@svelte-atproto/oauth/server', () => ({ createAtprotoAuth: mocks.create }));

async function declared(privateEvents: string | undefined, invitations?: string) {
	const { env } = await import('cloudflare:workers');
	Object.assign(env, {
		OAUTH_PUBLIC_URL: 'https://atmo.example',
		COOKIE_SECRET: 'secret',
		CLIENT_ASSERTION_KEY: 'private-key',
		PRIVATE_EVENTS: privateEvents,
		PRIVATE_EVENT_INVITATIONS: invitations
	});
	const { getAuth } = await import('#lib/atproto/server/oauth.js');
	getAuth();
	return (mocks.create.mock.calls[0][0] as AtprotoAuthConfig).scope;
}

beforeEach(() => {
	vi.resetModules();
	vi.clearAllMocks();
});
afterEach(async () => {
	const { env } = await import('cloudflare:workers');
	delete (env as { PRIVATE_EVENTS?: string }).PRIVATE_EVENTS;
	delete (env as { PRIVATE_EVENT_INVITATIONS?: string }).PRIVATE_EVENT_INVITATIONS;
});

describe('the sign-in permissions a deployment declares', () => {
	it('adds the private event permissions and the beta switch when private events are on', async () => {
		expect(await declared('true')).toEqual([...scopes, ...privateEventScopes(false), BETA_SCOPE]);
	});
	it('names the inbox type only when invitations are on too, since a PDS that can’t find it refuses the whole sign-in', async () => {
		const off = await declared('true');
		expect(off).not.toContain(INBOX_OWNER_SCOPE);
		expect(String(off)).not.toContain('rsvp.atmo.dev.inbox');
		vi.resetModules();
		vi.clearAllMocks();
		const on = await declared('true', 'true');
		expect(on).toEqual([...scopes, ...privateEventScopes(true), BETA_SCOPE]);
		expect(on).toContain(INBOX_OWNER_SCOPE);
		expect(on).toContain(INVITER_SCOPE);
	});
	it('leaves invitations off when private events are, whatever their own setting says', async () => {
		expect(await declared(undefined, 'true')).toEqual(scopes);
	});
	it('adds neither when they are off', async () => {
		expect(await declared(undefined)).toEqual(scopes);
	});
});

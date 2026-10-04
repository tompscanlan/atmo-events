// What the confidential client declares, since a PDS refuses any requested scope
// its served metadata does not list, and atcute refuses one its own does not.
import { describe, it, expect, beforeAll } from 'vitest';
import { generateClientAssertionKey } from '@atcute/oauth-node-client';
import { scopes } from '../settings';
import { createOAuthClient } from './oauth';

const GRANT =
	'space:*?authority=did:plc:kona0000000000000000000a&collection=group.opensocial.acceptance&action=create&action=update&action=delete';

let env: App.Platform['env'];

beforeAll(async () => {
	env = {
		OAUTH_PUBLIC_URL: 'https://atmo.example.com',
		CLIENT_ASSERTION_KEY: JSON.stringify(await generateClientAssertionKey('test-key'))
	} as unknown as App.Platform['env'];
});

describe('createOAuthClient', () => {
	it('declares exactly the base scopes when given no extras', () => {
		expect(createOAuthClient(env).metadata.scope).toBe(scopes.join(' '));
	});

	it('declares the extras after the base scopes', () => {
		expect(createOAuthClient(env, [GRANT]).metadata.scope).toBe([...scopes, GRANT].join(' '));
	});

	it('does not let a client built with extras replace the base client', () => {
		createOAuthClient(env, [GRANT]);
		expect(createOAuthClient(env).metadata.scope).toBe(scopes.join(' '));
	});

	it('lists the sign-in callback first, so a sign-in returns there, then the group-link callback', () => {
		expect(createOAuthClient(env).metadata.redirect_uris).toEqual([
			'https://atmo.example.com/oauth/callback',
			'https://atmo.example.com/oauth/group-link/callback'
		]);
	});

	it('lists a scope once when an extra repeats a base scope', () => {
		expect(createOAuthClient(env, [scopes[1]]).metadata.scope).toBe(scopes.join(' '));
	});

	it('refuses to request a grant its own metadata does not declare', async () => {
		await expect(
			createOAuthClient(env).authorize({
				target: { type: 'account', identifier: 'alice.test' },
				scope: [...scopes, GRANT].join(' ')
			})
		).rejects.toThrow(/not within client metadata's scope/);
	});
});

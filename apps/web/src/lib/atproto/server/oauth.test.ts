import { describe, it, expect, beforeAll } from 'vitest';
import { generateClientAssertionKey, type StoredState } from '@atcute/oauth-node-client';
import { scopes } from '../settings';
import { createOAuthClient, isSignInState, oauthStates } from './oauth';

const GRANT = 'include:group.opensocial.participate';

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
			'https://atmo.example.com/oauth/group-link/callback',
			'https://atmo.example.com/oauth/group-create/callback'
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

describe('isSignInState', () => {
	const stateFor = (path: string) =>
		({ redirectUri: `https://atmo.example.com${path}` }) as unknown as StoredState;

	it('takes a state its sign-in started, and no group flow’s', async () => {
		const states = oauthStates(env);
		await states.set('sign-in', stateFor('/oauth/callback'));
		await states.set('link', { ...stateFor('/oauth/group-link/callback'), userState: '{}' });
		await states.set('create', { ...stateFor('/oauth/group-create/callback'), userState: '{}' });

		expect(await isSignInState(env, 'sign-in')).toBe(true);
		expect(await isSignInState(env, 'link')).toBe(false);
		expect(await isSignInState(env, 'create')).toBe(false);
	});

	it('refuses an unknown state and a missing one', async () => {
		expect(await isSignInState(env, 'unknown')).toBe(false);
		expect(await isSignInState(env, null)).toBe(false);
	});
});

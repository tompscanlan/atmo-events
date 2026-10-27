import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';

const callback = vi.hoisted(() => vi.fn());

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	createOAuthClient: () => ({ callback })
}));

import { oauthStates } from '$lib/atproto/server/oauth';
import { GET } from './+server';

const at = (path: string) => `https://atmo.example.com${path}`;

function open(state: string) {
	const url = new URL(at(`/oauth/callback?state=${state}&code=c&iss=https://pds.example.com`));
	return GET({ url, platform: { env: {} }, cookies: {} } as unknown as Parameters<typeof GET>[0]);
}

beforeEach(async () => {
	callback.mockReset().mockRejectedValue(new Error('no token endpoint here'));
	const states = oauthStates(undefined);
	await states.set('sign-in', { redirectUri: at('/oauth/callback') } as unknown as StoredState);
	await states.set('link', {
		redirectUri: at('/oauth/group-link/callback'),
		userState: '{}'
	} as unknown as StoredState);
});

describe('/oauth/callback', () => {
	it('finishes only a sign-in, so a group-link callback cannot skip its own checks', async () => {
		await expect(open('link')).rejects.toMatchObject({ status: 303 });
		expect(callback).not.toHaveBeenCalled();
		expect(await oauthStates(undefined).get('link')).toBeDefined();
	});

	it('hands a sign-in to the client', async () => {
		await expect(open('sign-in')).rejects.toMatchObject({ status: 303 });
		expect(callback).toHaveBeenCalledOnce();
	});
});

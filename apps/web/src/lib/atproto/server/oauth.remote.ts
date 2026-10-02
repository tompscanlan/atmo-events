import * as v from 'valibot';
import { error } from '@sveltejs/kit';
import { command, getRequestEvent } from '$app/server';
import { createOAuthClient, resolveActorDid, servesClientMetadata } from './oauth';
import { getSignedCookie } from './signed-cookie';
import { scopes, signUpPDS } from '../settings';
import { firstAcceptedScope, signInGrantAttempts } from '$lib/groups/server/member-grants';
import type { ActorIdentifier, Did } from '@atcute/lexicons';

/** The group grants a sign-in tries, most first (see `signInGrantAttempts`). A
 *  signup, a loopback client, or a deployment without D1 asks for none. So does
 *  a handle that does not resolve here, and authorize then reports it as before. */
async function groupGrantAttempts(
	env: App.Platform['env'] | undefined,
	handle: string | undefined
): Promise<string[][]> {
	if (!handle || !env?.DB || !servesClientMetadata(env)) return [[]];
	try {
		const did = await resolveActorDid(handle as ActorIdentifier);
		return await signInGrantAttempts(env.DB, did, Date.now());
	} catch (e) {
		console.warn('[oauth] sign-in asks for no group grants:', e);
		return [[]];
	}
}

export const oauthLogin = command(
	v.object({
		handle: v.optional(v.pipe(v.string(), v.minLength(3))),
		signup: v.optional(v.boolean())
	}),
	async (input) => {
		const { platform } = getRequestEvent();

		try {
			const target = input.signup
				? ({ type: 'pds', serviceUrl: signUpPDS } as const)
				: ({ type: 'account', identifier: input.handle as ActorIdentifier } as const);

			const attempts = await groupGrantAttempts(
				platform?.env,
				input.signup ? undefined : input.handle
			);
			const { url } = await firstAcceptedScope(attempts, (grants) =>
				createOAuthClient(platform?.env, grants).authorize({
					target,
					scope: [...scopes, ...grants].join(' '),
					prompt: input.signup ? 'create' : undefined
				})
			);

			return { url: url.toString() };
		} catch (e) {
			if (e && typeof e === 'object' && 'status' in e) throw e; // re-throw SvelteKit errors
			const message = e instanceof Error ? e.message : 'Login failed';
			error(400, message);
		}
	}
);

export const oauthLogout = command(async () => {
	const { cookies, platform } = getRequestEvent();
	const did = getSignedCookie(cookies, 'did') as Did | null;

	if (did) {
		try {
			const oauth = createOAuthClient(platform?.env);
			await oauth.revoke(did);
		} catch (e) {
			console.error('Error revoking session:', e);
		}
	}

	cookies.delete('did', { path: '/' });
	cookies.delete('scope', { path: '/' });

	return { ok: true };
});

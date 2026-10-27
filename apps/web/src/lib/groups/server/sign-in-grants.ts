// Sign-in asks for the proposal's `participate` set on top of the base scope. A spaces
// PDS refuses a set whose lexicons do not resolve, with `invalid_scope`, so the sign-in
// then falls back to the base scope alone.
import { OAuthResponseError, type OAuthClient } from '@atcute/oauth-node-client';
import { createOAuthClient, servesClientMetadata } from '$lib/atproto/server/oauth';
import { scopes } from '$lib/atproto/settings';

export const GROUP_SIGN_IN_SCOPES = ['include:group.opensocial.participate'] as const;

type AuthorizeOptions = Pick<Parameters<OAuthClient['authorize']>[0], 'target' | 'prompt'>;

export function groupsEnabled(env: App.Platform['env'] | undefined): boolean {
	return Boolean(env?.GROUP_HOST_URL?.trim());
}

export async function authorizeSignIn(
	env: App.Platform['env'] | undefined,
	options: AuthorizeOptions
): ReturnType<OAuthClient['authorize']> {
	const authorize = (extras: readonly string[]) =>
		createOAuthClient(env, extras).authorize({
			...options,
			scope: [...scopes, ...extras].join(' ')
		});
	if (!groupsEnabled(env) || !servesClientMetadata(env)) return authorize([]);
	try {
		return await authorize(GROUP_SIGN_IN_SCOPES);
	} catch (e) {
		if (!(e instanceof OAuthResponseError && e.error === 'invalid_scope')) throw e;
		console.warn(`[groups] signing in without the groups scope: ${e.errorDescription ?? e.error}`);
		return authorize([]);
	}
}

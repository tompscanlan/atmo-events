// Sign-in asks for the proposal's `participate` set and the grant for members-only RSVPs
// on top of the base scope. A spaces PDS refuses a scope whose lexicons do not resolve,
// with `invalid_scope`, so the sign-in then asks for less: the set alone, then the base.
import { OAuthResponseError, type OAuthClient } from '@atcute/oauth-node-client';
import { createOAuthClient, servesClientMetadata } from '$lib/atproto/server/oauth';
import { scopes } from '$lib/atproto/settings';
import { GROUP_RSVP_COLLECTION } from '../ids';
import { CALENDAR_SPACE_TYPE } from '../types';

const PARTICIPATE = 'include:group.opensocial.participate';

/** A member's RSVPs in any group's calendar space; with it the PDS also lets them read the space. */
export const CALENDAR_RSVP_SCOPE = `space:${CALENDAR_SPACE_TYPE}?authority=*&collection=${GROUP_RSVP_COLLECTION}&action=read&action=create&action=update&action=delete`;

export const GROUP_SIGN_IN_SCOPES = [PARTICIPATE, CALENDAR_RSVP_SCOPE] as const;

const ASKS: readonly (readonly string[])[] = [GROUP_SIGN_IN_SCOPES, [PARTICIPATE]];

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
	for (const extras of ASKS) {
		try {
			return await authorize(extras);
		} catch (e) {
			if (!(e instanceof OAuthResponseError && e.error === 'invalid_scope')) throw e;
			console.warn(
				`[groups] signing in with less of the groups scope: ${e.errorDescription ?? e.error}`
			);
		}
	}
	return authorize([]);
}

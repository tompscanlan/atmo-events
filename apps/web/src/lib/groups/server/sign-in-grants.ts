// Sending a member to their PDS with the group grants on top of the base scope:
// at sign-in (`authorizeSignIn`), and again after a join (remote-context's
// `reauthorizeUrl`). Which grants to ask for is member-grants'. This file only
// starts the authorization, so member-grants never imports the OAuth client.
import type { ActorIdentifier } from '@atcute/lexicons';
import type { OAuthClient } from '@atcute/oauth-node-client';
import {
	createOAuthClient,
	resolveActorDid,
	servesClientMetadata
} from '$lib/atproto/server/oauth';
import { scopes } from '$lib/atproto/settings';
import { firstAcceptedScope, signInGrantAttempts } from './member-grants';

type AuthorizeOptions = Parameters<OAuthClient['authorize']>[0];

/** Starts an authorization that asks for the base scope plus `grants`. The client
 *  declares the grants too, since a PDS refuses a scope its metadata lacks. */
export function authorizeWithGrants(
	env: App.Platform['env'] | undefined,
	grants: readonly string[],
	options: Pick<AuthorizeOptions, 'target' | 'prompt'>
): ReturnType<OAuthClient['authorize']> {
	return createOAuthClient(env, grants).authorize({
		...options,
		scope: [...scopes, ...grants].join(' ')
	});
}

/** Starts a sign-in as `handle` (none for a signup) that asks for the grants of
 *  the groups it belongs to, dropping them set by set while the PDS refuses
 *  them (see `signInGrantAttempts`). */
export async function authorizeSignIn(
	env: App.Platform['env'] | undefined,
	handle: string | undefined,
	options: Pick<AuthorizeOptions, 'target' | 'prompt'>
): ReturnType<OAuthClient['authorize']> {
	return firstAcceptedScope(await signInGrants(env, handle), (grants) =>
		authorizeWithGrants(env, grants, options)
	);
}

/** The grant sets a sign-in as `handle` tries. A signup, a loopback client, or a
 *  deployment without D1 asks for none. So does a handle that does not resolve
 *  here, and authorize then reports it as before. */
async function signInGrants(
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

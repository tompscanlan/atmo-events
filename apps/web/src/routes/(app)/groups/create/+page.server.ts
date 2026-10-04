import { redirect } from '@sveltejs/kit';
import { servesClientMetadata } from '$lib/atproto/server/oauth';
import { mintConfig } from '$lib/groups/create-group';
import type { PageServerLoad } from './$types';

/** Checks whether this deployment can mint, so the page can say "not
 *  configured" before the form is filled in. Linking counts: a group whose
 *  owner cannot link its account is a group this site can never write as. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/');
	const env = platform!.env;
	const canLink = servesClientMetadata(env) && Boolean(env.OAUTH_PUBLIC_URL);

	return {
		mintConfigured: mintConfig(env) !== null && canLink,
		handleDomain: env.GROUP_HANDLE_DOMAIN?.trim() || null,
		ownerDid: locals.did
	};
};

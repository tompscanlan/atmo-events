import { redirect } from '@sveltejs/kit';
import { canStoreMintedCredentials } from '$lib/groups/server/credentials';
import type { PageServerLoad } from './$types';

/** Checks whether this deployment can mint, so the page can say "not
 *  configured" before the form is filled in. The credential key is checked,
 *  not just assumed, since a mint whose credential cannot be stored strands a
 *  did:plc. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/');
	const env = platform!.env;
	const mintConfigured =
		Boolean(
			env.GROUP_PDS_SERVICE?.trim() &&
			env.GROUP_HANDLE_DOMAIN?.trim() &&
			env.GROUP_PDS_INVITE_CODE?.trim() &&
			env.GROUP_ACCOUNT_EMAIL?.trim()
		) && (await canStoreMintedCredentials(env));

	return {
		mintConfigured,
		handleDomain: env.GROUP_HANDLE_DOMAIN?.trim() || null,
		ownerDid: locals.did
	};
};

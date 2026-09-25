import { redirect } from '@sveltejs/kit';
import { canStoreMintedCredentials } from '$lib/groups/server/credentials';
import type { PageServerLoad } from './$types';

/** Creating a group mints its identity, so there is no DID to choose and
 *  nothing for an operator to set up per group. The page still needs to know
 *  whether this deployment can mint at all (the five vars in
 *  `App.Platform['env']`), so it can say "not configured" before someone fills
 *  in the form, not after a POST.
 *
 *  The credential key is checked, not just assumed present: without a usable
 *  key a mint could succeed and then leave a did:plc whose credential cannot be
 *  stored. */
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

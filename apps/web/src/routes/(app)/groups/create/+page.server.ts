import { redirect } from '@sveltejs/kit';
import { canStoreMintedCredentials } from '$lib/groups/server/credentials';
import type { PageServerLoad } from './$types';

/** Creating a group MINTS its identity, so there is no DID to choose
 *  and nothing for an operator to pre-provision. What the page still needs to
 *  know is whether this deployment can mint at all — the five vars in
 *  `App.Platform['env']` — because the honest place to say "not configured" is
 *  before someone fills the form in, not after a POST.
 *
 *  The credential key is checked here rather than assumed: it is the one piece
 *  whose absence would let a mint succeed and then strand a did:plc with an
 *  unstorable credential. (Spec: FR-001.) */
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
		ownerDid: locals.did
	};
};

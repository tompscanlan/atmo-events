import { redirect } from '@sveltejs/kit';
import { AUTO_MINT_GROUP_DID, custodialDids } from '$lib/groups/server/credentials';
import type { PageServerLoad } from './$types';

/** Creation BINDS an existing custodial DID — it never mints a did:plc. The
 *  form therefore offers the DIDs this deployment actually holds credentials
 *  for; anything else would create a group that can never publish an event. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/login');
	return {
		custodialDids: custodialDids(platform!.env),
		autoMintEnabled: AUTO_MINT_GROUP_DID,
		ownerDid: locals.did
	};
};

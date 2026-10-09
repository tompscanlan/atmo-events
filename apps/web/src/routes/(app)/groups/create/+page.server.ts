import { redirect } from '@sveltejs/kit';
import { creationConfig } from '$lib/groups/create-group';
import type { PageServerLoad } from './$types';

/** Checks whether this deployment can create a group, so the page can say "not
 *  configured" instead of offering a form the server would refuse. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/');
	const env = platform!.env;

	return {
		creationConfigured: creationConfig(env) !== null,
		handleDomain: env.GROUP_HANDLE_DOMAIN?.trim() || null,
		ownerDid: locals.did
	};
};

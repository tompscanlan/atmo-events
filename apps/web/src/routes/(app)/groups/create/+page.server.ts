import { redirect } from '@sveltejs/kit';
import { hostCreation } from '$lib/groups/create-at-host';
import type { PageServerLoad } from './$types';

/** Checks whether this deployment can create a group, so the page can say "not
 *  configured" instead of offering a form the server would refuse. Groups are
 *  made at the group host, so that means a host it can link. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/');
	return { creationConfigured: hostCreation(platform!.env) !== null };
};

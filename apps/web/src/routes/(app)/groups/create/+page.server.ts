import { redirect } from '@sveltejs/kit';
import { hostCreation } from '$lib/groups/create-at-host';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, platform }) => {
	if (!locals.did) redirect(303, '/');
	return { canCreate: hostCreation(platform!.env) !== null };
};

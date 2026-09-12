import { listGroups } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** Browse. Anonymous callers get published+public groups only; a signed-in
 *  caller also gets the groups they own or are on the roster of, at any status —
 *  the visibility filter lives in SQL (see listGroups) so the page cannot widen
 *  it by accident. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	return {
		groups: await listGroups(platform!.env.DB, { callerDid: locals.did }),
		callerDid: locals.did
	};
};

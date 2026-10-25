import { redirect } from '@sveltejs/kit';
import { oauthStates } from '$lib/atproto/server/oauth';
import { mayHoldGroupSession } from '$lib/groups/grants';
import { gateCaller } from '$lib/groups/server/caller';
import { finishGroupLink } from '$lib/groups/server/group-link';

import { groupPath, groupRouteContext } from '$lib/groups/server/route-context';
import type { RequestHandler } from './$types';

import { groupLinkClient } from '$lib/groups/server/session';
import { getGroupByDid } from '$lib/groups/server/db/groups';
// Where the group's host returns after a person authorizes this app as the group.
// It sets no cookie: the browser stays signed in as that person.
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = platform?.env;
	if (!env?.DB) redirect(303, '/?error=group_link_failed');
	const db = env.DB;

	const result = await finishGroupLink({
		clientFor: (personDid) => groupLinkClient(env, personDid),
		states: oauthStates(env),
		params: url.searchParams,
		signedInDid: locals.did,
		findGroup: (did) => getGroupByDid(db, did),
		mayConnect: async (groupDid) => {
			try {
				const { membership } = await groupRouteContext(
					db,
					groupDid,
					await gateCaller(locals.did, locals.session)
				);
				return mayHoldGroupSession(membership);
			} catch (e) {
				// The group's 404 for someone who may no longer see it is a no.
				console.error(`[groups] ${groupDid}: the link's standing read failed:`, e);
				return false;
			}
		}
	});

	if (!result.ok) {
		console.error(`[groups] group link refused: ${result.reason}`);
		if (!result.groupDid) redirect(303, '/?error=group_link_failed');
		redirect(303, `${groupPath({ group_did: result.groupDid })}?link=failed`);
	}
	console.info(`[groups] ${result.groupDid} linked by ${locals.did}`);
	redirect(303, `${groupPath({ group_did: result.groupDid })}?link=linked`);
};

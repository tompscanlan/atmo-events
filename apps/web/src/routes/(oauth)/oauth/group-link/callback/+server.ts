import { redirect } from '@sveltejs/kit';
import { oauthStates } from '$lib/atproto/server/oauth';
import { finishGroupLink } from '$lib/groups/server/group-link';
import { groupLinkClient } from '$lib/groups/server/linked-session';
import { getGroupByDid } from '$lib/groups/server/repo';
import { groupPath } from '$lib/groups/server/route-context';
import type { RequestHandler } from './$types';

// Where the group's PDS returns after its owner authorizes this app as the group.
// It sets no cookie: the browser stays signed in as the owner.
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = platform?.env;
	if (!env?.DB) redirect(303, '/?error=group_link_failed');
	const db = env.DB;

	const result = await finishGroupLink({
		client: groupLinkClient(env),
		states: oauthStates(env),
		params: url.searchParams,
		signedInDid: locals.did,
		findGroup: (did) => getGroupByDid(db, did)
	});

	if (!result.ok) {
		console.error(`[groups] group link refused: ${result.reason}`);
		if (!result.groupDid) redirect(303, '/?error=group_link_failed');
		redirect(303, `${groupPath({ group_did: result.groupDid })}?link=failed`);
	}
	console.info(`[groups] ${result.groupDid} linked by ${locals.did}`);
	redirect(303, `${groupPath({ group_did: result.groupDid })}?link=linked`);
};

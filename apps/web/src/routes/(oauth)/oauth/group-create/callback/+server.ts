import { redirect } from '@sveltejs/kit';
import { oauthStates } from '$lib/atproto/server/oauth';
import { finishCreateAtHost } from '$lib/groups/create-at-host';
import { groupPath } from '$lib/groups/server/route-context';
import type { RequestHandler } from './$types';

import { groupLinkClient } from '$lib/groups/server/session';
import { kvAvatarStash } from '$lib/groups/server/avatar-stash';
// Where a group host returns after the person signs up a new group there
// (lib/groups/create-at-host.ts). It sets no cookie: the browser stays signed in
// as that person, and the group's session is filed under them.
export const GET: RequestHandler = async ({ url, locals, platform }) => {
	const env = platform?.env;
	if (!env?.DB) redirect(303, '/?error=group_create_failed');

	const result = await finishCreateAtHost({
		env: { ...env, DB: env.DB },
		clientFor: (personDid) => groupLinkClient(env, personDid),
		states: oauthStates(env),
		params: url.searchParams,
		signedInDid: locals.did,
		stash: kvAvatarStash(env.OAUTH_STATES)
	});

	if (!result.ok) {
		console.error(
			`[groups] create at the group host failed${result.groupDid ? ` for ${result.groupDid}` : ''}: ${result.error}`
		);
		redirect(303, `/groups/create?${new URLSearchParams({ error: result.error })}`);
	}
	console.info(`[groups] ${result.groupDid} created at the group host by ${locals.did}`);
	redirect(303, `${groupPath({ group_did: result.groupDid })}?link=linked`);
};

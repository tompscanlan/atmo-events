import { error, redirect } from '@sveltejs/kit';
import { GROUP_LINK_REDIRECT_PATH } from '$lib/atproto/settings';
import { GroupLinkRefused, startGroupLink } from '$lib/groups/server/group-link';

import { GROUP_NOT_FOUND } from '$lib/groups/server/route-context';
import type { RequestHandler } from './$types';

import { groupLinkClient, groupLinkConfigured } from '$lib/groups/server/session';
import { getGroupByDid } from '$lib/groups/server/db/groups';
// Starts linking a group's account (lib/groups/server/group-link.ts). A plain
// form post from the group page, answered with a redirect to the group's PDS.
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = platform?.env;
	if (!env?.DB) error(503, 'Groups are not available on this deployment');
	if (!groupLinkConfigured(env)) {
		error(501, 'This deployment cannot link a group: it serves no client metadata of its own');
	}
	if (!locals.did) error(401, 'Sign in as the group’s owner to link it');

	const groupDid = (await request.formData()).get('groupDid');
	const group = typeof groupDid === 'string' ? await getGroupByDid(env.DB, groupDid) : null;
	// A caller who is not the owner gets the same 404 as a group that does not
	// exist, as every group route answers (route-context.ts).
	if (!group) error(404, GROUP_NOT_FOUND);

	let url: URL;
	try {
		url = await startGroupLink({
			client: groupLinkClient(env),
			group,
			signedInDid: locals.did,
			redirectUri: env.OAUTH_PUBLIC_URL + GROUP_LINK_REDIRECT_PATH
		});
	} catch (e) {
		if (e instanceof GroupLinkRefused) error(404, GROUP_NOT_FOUND);
		throw e;
	}
	redirect(303, url.toString());
};

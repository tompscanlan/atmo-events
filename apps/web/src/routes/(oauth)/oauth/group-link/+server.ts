import { error, redirect } from '@sveltejs/kit';
import { GROUP_LINK_REDIRECT_PATH } from '$lib/atproto/settings';
import { mayHoldGroupSession } from '$lib/groups/grants';
import { gateCaller } from '$lib/groups/server/acceptance';
import { GroupLinkRefused, startGroupLink } from '$lib/groups/server/group-link';
import { isHostGroup } from '$lib/groups/server/host-kind';

import { GROUP_NOT_FOUND, groupRouteContext } from '$lib/groups/server/route-context';
import type { RequestHandler } from './$types';

import { groupLinkClient, groupLinkConfigured } from '$lib/groups/server/session';
// Starts linking a group session for the signed-in person
// (lib/groups/server/group-link.ts). A plain form post from the group page,
// answered with a redirect to the group's host.
export const POST: RequestHandler = async ({ request, locals, platform }) => {
	const env = platform?.env;
	if (!env?.DB) error(503, 'Groups are not available on this deployment');
	if (!groupLinkConfigured(env)) {
		error(501, 'This deployment cannot link a group: it serves no client metadata of its own');
	}
	if (!locals.did) error(401, 'Sign in to link a group session');

	const groupDid = (await request.formData()).get('groupDid');
	if (typeof groupDid !== 'string') error(404, GROUP_NOT_FOUND);
	// Their roles, read with their own access, as every group route reads them.
	const { group, membership } = await groupRouteContext(
		env.DB,
		groupDid,
		await gateCaller(locals.did, locals.session)
	);

	let url: URL;
	try {
		url = await startGroupLink({
			client: groupLinkClient(env, locals.did),
			group,
			signedInDid: locals.did,
			mayConnect: mayHoldGroupSession(membership),
			atGroupHost: () => isHostGroup(env, group.group_did),
			redirectUri: env.OAUTH_PUBLIC_URL + GROUP_LINK_REDIRECT_PATH
		});
	} catch (e) {
		// A caller whose roles grant no writes gets the same 404 as a group that
		// does not exist, as the link has always answered anyone who may not write.
		if (e instanceof GroupLinkRefused) error(404, GROUP_NOT_FOUND);
		throw e;
	}
	redirect(303, url.toString());
};

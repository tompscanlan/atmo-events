import { json } from '@sveltejs/kit';
import { createOAuthClient } from '$lib/atproto/server/oauth';
import { GROUP_SESSION_SCOPES } from '$lib/groups/server/session';
import { GROUP_SIGN_IN_SCOPES, groupsEnabled } from '$lib/groups/server/sign-in-grants';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ platform }) => {
	const extras = groupsEnabled(platform?.env)
		? [...GROUP_SIGN_IN_SCOPES, ...GROUP_SESSION_SCOPES]
		: [];
	const oauth = createOAuthClient(platform?.env, extras);
	return json(oauth.metadata);
};

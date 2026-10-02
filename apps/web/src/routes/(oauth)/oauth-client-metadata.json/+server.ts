import { json } from '@sveltejs/kit';
import { createOAuthClient } from '$lib/atproto/server/oauth';
import { declaredGrants } from '$lib/groups/server/member-grants';
import type { RequestHandler } from './$types';

// Declares each group's member grant as well as the base scopes, because a PDS
// refuses any requested scope the metadata does not list.
export const GET: RequestHandler = async ({ platform }) => {
	const grants = platform?.env.DB ? await declaredGrants(platform.env.DB) : [];
	const oauth = createOAuthClient(platform?.env, grants);
	return json(oauth.metadata);
};

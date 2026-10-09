import { json } from '@sveltejs/kit';
import { createOAuthClient } from '$lib/atproto/server/oauth';
import { declaredGrants } from '$lib/groups/server/member-grants';

import type { RequestHandler } from './$types';

import { GROUP_SESSION_SCOPES } from '$lib/groups/server/session';
// Declares each group's member grant and the scope a group's owner grants when
// linking it, as well as the base scopes, because a PDS refuses any requested
// scope the metadata does not list. Sign-in never asks for the group scope.
export const GET: RequestHandler = async ({ platform }) => {
	const grants = platform?.env.DB ? await declaredGrants(platform.env.DB) : [];
	const oauth = createOAuthClient(platform?.env, [...grants, ...GROUP_SESSION_SCOPES]);
	return json(oauth.metadata);
};

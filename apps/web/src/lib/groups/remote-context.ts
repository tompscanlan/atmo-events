import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import type { CallerMembership, GroupRow, GroupVisibility } from './types';
import type { GroupSpaceReader } from './server/about-read';
import { gateCaller } from './server/caller';
import { groupRouteContext, type GroupRouteOptions } from './server/route-context';

export interface GroupRequestContext {
	db: D1Database;
	env: App.Platform['env'];
	group: GroupRow;
	membership: CallerMembership;
	visibility: GroupVisibility | null;
	reader: GroupSpaceReader | null;
	callerDid: string;
}

/** 401 when signed out, else the pages' own 404, so a form cannot probe for private groups. */
export async function groupRequestContext(
	actor: string,
	options: GroupRouteOptions = {}
): Promise<GroupRequestContext> {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const { group, membership, visibility, reader } = await groupRouteContext(
		db,
		actor,
		await gateCaller(locals.did, locals.session),
		options
	);
	return { db, env: platform!.env, group, membership, visibility, reader, callerDid: locals.did };
}

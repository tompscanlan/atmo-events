// What every group remote resolves before it acts. A plain module, since a
// `*.remote.ts` may export only remote functions.
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
	/** Null when the caller's sign-in reads no spaces. */
	reader: GroupSpaceReader | null;
	callerDid: string;
}

/** 401 when signed out, and the pages' own 404 for every other refusal: anyone signed
 *  in can post a remote form with any group key, so a lookup of its own could reveal
 *  that a private group exists. */
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

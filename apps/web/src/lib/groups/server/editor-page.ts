// What atmo's event editor needs to publish as a group, for the new-event and
// edit pages. The pages are only a first gate; every save is checked again by
// the writer (./event-writer.ts).
import { error } from '@sveltejs/kit';
import { can, type GroupPermission } from '../permissions';

import { groupHeader, groupRouteContext } from './route-context';

import { type CredentialStoreEnv } from './session';

export async function groupEditorPage(
	env: CredentialStoreEnv & { DB: D1Database },
	actor: string,
	callerDid: string | null,
	permission: GroupPermission
) {
	const db = env.DB;
	const { group, membership, reader } = await groupRouteContext(env, db, actor, callerDid);
	if (!can(membership.permissions, permission)) {
		error(403, callerDid ? `Not allowed: ${permission} required` : 'Sign in to publish as a group');
	}
	const { groupName, handle } = await groupHeader(db, group, reader);
	return {
		group,
		/** For a page that goes on to read a members-only event: the caller's
		 *  standing and the group's reader, so it reads neither again. */
		membership,
		reader,
		groupDid: group.group_did,
		/** The editor shows the group as the host, by the profile record's name. */
		groupName,
		handle,
		canDelete: can(membership.permissions, 'MANAGE_EVENTS')
	};
}

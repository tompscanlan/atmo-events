// What atmo's event editor needs to publish as a group, for the new-event and
// edit pages. The pages are only a first gate; every save is checked again by
// the writer (./event-writer.ts).
import { error } from '@sveltejs/kit';
import { can, type GroupPermission } from '../permissions';

import type { MemberSession } from './acceptance';
import { groupHeader, groupRouteContext } from './route-context';

export async function groupEditorPage(
	db: D1Database,
	actor: string,
	caller: MemberSession | null,
	permission: GroupPermission
) {
	const { group, membership, reader } = await groupRouteContext(db, actor, caller);
	if (!can(membership.permissions, permission)) {
		error(403, caller ? `Not allowed: ${permission} required` : 'Sign in to publish as a group');
	}
	const { groupName, handle } = await groupHeader(db, group, reader);
	return {
		group,
		/** For a page that goes on to read a members-only event: the caller's
		 *  standing and their own reader, so it reads neither again. */
		membership,
		reader,
		groupDid: group.group_did,
		/** The editor shows the group as the host, by the profile record's name. */
		groupName,
		handle,
		canDelete: can(membership.permissions, 'MANAGE_EVENTS')
	};
}

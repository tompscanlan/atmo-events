// The pages are only a first gate; the writer checks every save again.
import { error } from '@sveltejs/kit';
import { can, type GroupPermission } from '../permissions';

import type { CallerSession } from './caller';
import { groupHeader, groupRouteContext } from './route-context';

export async function groupEditorPage(
	db: D1Database,
	actor: string,
	caller: CallerSession | null,
	permission: GroupPermission
) {
	const { group, membership, reader } = await groupRouteContext(db, actor, caller);
	if (!can(membership.permissions, permission)) {
		error(403, caller ? `Not allowed: ${permission} required` : 'Sign in to publish as a group');
	}
	const { groupName, handle } = await groupHeader(db, group, reader);
	return {
		groupDid: group.group_did,
		groupName,
		handle,
		canDelete: can(membership.permissions, 'MANAGE_EVENTS')
	};
}

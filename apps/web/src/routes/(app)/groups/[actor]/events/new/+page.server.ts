import { now as tidNow } from '@atcute/tid';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import { groupSpaceUris } from '$lib/groups/server/space-uris';
import type { PageServerLoad } from './$types';

/** atmo's event editor, publishing a new event as the group. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const { groupDid, groupName, handle } = await groupEditorPage(
		platform!.env,
		params.actor,
		locals.did,
		'CREATE_EVENT'
	);
	// Where a members-only event goes. Computed from the DID, so it costs no
	// call, and the page never builds a space URI itself. Whether the group has
	// this space yet is the writer's check, before each members-only save.
	const { calendarSpaceUri } = groupSpaceUris(groupDid);
	return { groupDid, groupName, handle, rkey: tidNow(), calendarSpaceUri };
};

import { now as tidNow } from '@atcute/tid';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import type { PageServerLoad } from './$types';

/** atmo's event editor, publishing a new event as the group. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const { groupDid, groupName, handle } = await groupEditorPage(
		platform!.env,
		params.actor,
		locals.did,
		'CREATE_EVENT'
	);
	return { groupDid, groupName, handle, rkey: tidNow() };
};

import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '$lib/contrail';
import { getServerClient } from '$lib/contrail/index';
import { gateCaller } from '$lib/groups/server/acceptance';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import type { PageServerLoad } from './$types';

/** atmo's event editor on one of the group's events, read from the index as
 *  atmo's own edit page reads a person's. */
export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const { groupDid, groupName, handle, canDelete } = await groupEditorPage(
		platform!.env.DB,
		params.actor,
		await gateCaller(locals.did, locals.session),
		'MANAGE_EVENTS'
	);
	const record = await getEventRecordFromContrail(getServerClient(platform!.env.DB), {
		did: groupDid,
		rkey: params.rkey
	}).catch(() => null);
	const eventData = record ? flattenEventRecord(record) : null;
	if (!eventData) error(404, 'Event not found');
	return { groupDid, groupName, handle, canDelete, rkey: params.rkey, eventData };
};

import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '$lib/contrail';
import { getServerClient } from '$lib/contrail/index';
import { membersOnlyEventForEditing, readMembersOnlyEvent } from '$lib/groups/server/calendar-read';
import { gateCaller } from '$lib/groups/server/caller';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import type { PageServerLoad } from './$types';

const EVENT_NOT_FOUND = 'Event not found';

/** atmo's event editor on one of the group's events: a public one read from the index as atmo's
 *  own edit page reads a person's; a members-only one, only when the link says
 *  `?placement=members`, from the calendar space with the caller's own access. A public and a
 *  members-only event can share a key, so the page never guesses. */
export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const { group, membership, reader, groupDid, groupName, handle, canDelete } =
		await groupEditorPage(
			platform!.env.DB,
			params.actor,
			await gateCaller(locals.did, locals.session),
			'MANAGE_EVENTS'
		);
	const placement = url.searchParams.get('placement');
	if (placement === 'members') {
		// Whole, image included: the editor saves what it loads.
		const read = await readMembersOnlyEvent(membership, reader, group, params.rkey);
		if (read.status === 'hidden' || read.status === 'absent') error(404, EVENT_NOT_FOUND);
		if (read.status !== 'found') error(503, read.notice);
		const eventData = membersOnlyEventForEditing(read.event, group);
		if (!eventData) error(404, EVENT_NOT_FOUND);
		const base = { groupDid, groupName, handle, canDelete, rkey: params.rkey };
		return { ...base, eventData, space: read.event.space };
	}
	if (placement !== null) error(404, EVENT_NOT_FOUND);

	const record = await getEventRecordFromContrail(getServerClient(platform!.env.DB), {
		did: groupDid,
		rkey: params.rkey
	}).catch(() => null);
	const eventData = record ? flattenEventRecord(record) : null;
	if (!eventData) error(404, EVENT_NOT_FOUND);
	return { groupDid, groupName, handle, canDelete, rkey: params.rkey, eventData, space: null };
};

import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '$lib/contrail';
import { getServerClient } from '$lib/contrail/index';
import { membersOnlyEventForEditing, readMembersOnlyEvent } from '$lib/groups/server/calendar-read';
import { groupEditorPage } from '$lib/groups/server/editor-page';
import type { PageServerLoad } from './$types';

/** A key the event's placement does not hold, and a placement the page does not
 *  know, both get this. */
const EVENT_NOT_FOUND = 'Event not found';

/**
 * atmo's event editor on one of the group's events, behind MANAGE_EVENTS.
 *
 * A public event is read from the index as atmo's own edit page reads a
 * person's. A members-only event is read from the group's calendar space, and
 * only when the link says so with ?placement=members: a public and a
 * members-only event can share a key, so the page never guesses, and a link
 * without the param reads the index. Any other value is a
 * 404 with no read, so a mangled link never falls through to the public read.
 *
 * A caller who may not edit gets the editor gate's 403 before any of this, the
 * same for every key and every placement, so the answer says nothing about
 * whether an event exists, and nothing is read for them past their standing.
 * (Spec: FR-117.)
 *
 * The page gets the placement as its own `space`, never on the event: the
 * editor saves what it loads, and a key on the event naming the container
 * would be written into the record. (Spec: FR-104, FR-116.)
 */
export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const { group, membership, reader, groupDid, groupName, handle, canDelete } =
		await groupEditorPage(platform!.env, params.actor, locals.did, 'MANAGE_EVENTS');

	const placement = url.searchParams.get('placement');
	if (placement === 'members') {
		// The same read as the event's own page, whole: the editor writes the image
		// back, so a copy without it would delete it on the next save. Nothing is
		// cached and nothing falls back to the index. (Spec: FR-117, FR-119.)
		const read = await readMembersOnlyEvent(membership, reader, group, params.rkey);
		if (read.status === 'hidden' || read.status === 'absent') error(404, EVENT_NOT_FOUND);
		if (read.status !== 'found') error(503, read.notice);
		const eventData = membersOnlyEventForEditing(read.event, group);
		if (!eventData) error(404, EVENT_NOT_FOUND);
		return {
			groupDid,
			groupName,
			handle,
			canDelete,
			rkey: params.rkey,
			eventData,
			space: read.event.space
		};
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

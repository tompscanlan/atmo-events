import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '#lib/contrail.js';
import { getServerClient } from '#lib/contrail/index.js';
import type { EventPlacement } from '#lib/groups/event-placement.js';
import { GROUP_NOT_FOUND, groupView, requireGroupWriter } from '#lib/groups/server/context.js';
import { flatSpaceEvent } from '#lib/groups/server/calendar-read.js';
import { readMembersOnlyEventAsGroup } from '#lib/groups/server/group-events.js';

// The event is where it was first written, and stays there: the index has a public one, and
// the group's calendar space a members-only one, read here as the group.
export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	if (!group.linked) error(404, GROUP_NOT_FOUND);

	const record = await getEventRecordFromContrail(getServerClient(env.DB), {
		did: group.did,
		rkey: params.rkey
	}).catch(() => null);
	let eventData = record ? flattenEventRecord(record) : null;
	let placement: EventPlacement = 'everyone';
	if (!eventData) {
		const writer = await requireGroupWriter(group.did, locals.did);
		const found = await readMembersOnlyEventAsGroup(writer, params.rkey).catch((e) => {
			console.error(`[groups] ${group.did}: members-only event ${params.rkey} unread:`, e);
			error(503, 'This event could not be read right now. Try again shortly.');
		});
		// Whole, as stored: the editor saves what it loads, so a field left out would go.
		eventData = found ? flatSpaceEvent(group.did, found) : null;
		placement = 'members';
	}
	if (!eventData) error(404, 'Event not found');

	return {
		pageTitle: `Edit event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		eventData,
		rkey: params.rkey,
		placement
	};
}

import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '#lib/contrail.js';
import { getServerClient } from '#lib/contrail/index.js';
import type { EventPlacement } from '#lib/groups/event-placement.js';
import { storedMembersOnlyEvent } from '#lib/groups/server/calendar-read.js';
import {
	GROUP_NOT_FOUND,
	groupView,
	NO_POSTING,
	requireGroupWriter
} from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { readMembersOnlyEventAsGroup } from '#lib/groups/server/group-events.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

// The event stays where it was first written: the index has a public one, and the group's calendar
// space a members-only one, read here as the group.
export async function load({ params, locals, setHeaders }) {
	requireGroupsEnabled();
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals.did);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	const { can } = group.linked;
	if (!can.post && !can.membersOnly) error(403, NO_POSTING);

	const record = can.post
		? await getEventRecordFromContrail(getServerClient(env.DB), {
				did: group.did,
				rkey: params.rkey
			}).catch(() => null)
		: null;
	let eventData = record ? flattenEventRecord(record) : null;
	let placement: EventPlacement = 'everyone';
	if (!eventData && can.membersOnly) {
		const writer = await requireGroupWriter(group.did, locals.did);
		const found = await readMembersOnlyEventAsGroup(writer, params.rkey).catch((e) => {
			console.error(`[groups] a members-only event unread for its edit page: ${errorKind(e)}`);
			error(503, 'This event could not be read right now. Try again shortly.');
		});
		eventData = found ? storedMembersOnlyEvent(group.did, found) : null;
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

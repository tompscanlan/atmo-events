import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { flattenEventRecord, getEventRecordFromContrail } from '#lib/contrail.js';
import { getServerClient } from '#lib/contrail/index.js';
import { GROUP_NOT_FOUND, groupView } from '#lib/groups/server/context.js';

export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	if (!group.linked) error(404, GROUP_NOT_FOUND);

	const record = await getEventRecordFromContrail(getServerClient(env.DB), {
		did: group.did,
		rkey: params.rkey
	}).catch(() => null);
	const eventData = record ? flattenEventRecord(record) : null;
	if (!eventData) error(404, 'Event not found');

	return {
		pageTitle: `Edit event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		eventData,
		rkey: params.rkey
	};
}

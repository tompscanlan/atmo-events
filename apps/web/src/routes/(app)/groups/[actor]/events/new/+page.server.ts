import { error } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import { GROUP_NOT_FOUND, groupView } from '#lib/groups/server/context.js';

export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals.did);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	return {
		pageTitle: `New event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		rkey: tidNow()
	};
}

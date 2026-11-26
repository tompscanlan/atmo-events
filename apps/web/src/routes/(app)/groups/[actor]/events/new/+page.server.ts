import { error } from '@sveltejs/kit';
import { now as tidNow } from '@atcute/tid';
import { GROUP_NOT_FOUND, groupView, NO_POSTING } from '#lib/groups/server/context.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';

export async function load({ params, locals, setHeaders }) {
	requireGroupsEnabled();
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals.did);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	if (!group.linked.can.post) error(403, NO_POSTING);
	return {
		pageTitle: `New event - ${group.name}`,
		group: { did: group.did, handle: group.handle, name: group.name },
		rkey: tidNow()
	};
}

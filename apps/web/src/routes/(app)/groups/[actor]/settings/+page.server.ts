import { error } from '@sveltejs/kit';
import {
	GROUP_NOT_FOUND,
	groupView,
	NO_SETTINGS,
	requireGroupWriter
} from '#lib/groups/server/context.js';
import { requireGroupsEnabled, requireSettingsInBuild } from '#lib/groups/server/enabled.js';
import { readGroupSettings } from '#lib/groups/server/settings.js';
import { isLinkBroken, isRoleRefused } from '#lib/groups/server/xrpc.js';

// Writes as the group, so only someone who linked it, with a link that may, gets the form.
export async function load({ params, locals, setHeaders }) {
	requireGroupsEnabled();
	requireSettingsInBuild();
	setHeaders({ 'cache-control': 'no-store' });
	const group = await groupView(params.actor, locals.did);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	const summary = { did: group.did, name: group.name };
	if (!group.linked.can.settings) {
		// A link approved before settings were asked for: approving again may bring them.
		if (group.linked.reapprove) {
			return { pageTitle: `Settings - ${group.name}`, group: summary, reapprove: true as const };
		}
		error(403, NO_SETTINGS);
	}
	const writer = await requireGroupWriter(group.did, locals.did);
	const settings = await readGroupSettings(writer).catch((e: unknown) => {
		if (isRoleRefused(e)) error(403, NO_SETTINGS);
		if (isLinkBroken(e)) error(404, GROUP_NOT_FOUND);
		throw e;
	});
	return {
		pageTitle: `Settings - ${group.name}`,
		group: summary,
		reapprove: false as const,
		settings
	};
}

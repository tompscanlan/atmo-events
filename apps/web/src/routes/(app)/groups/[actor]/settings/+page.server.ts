import { error } from '@sveltejs/kit';
import { GROUP_NOT_FOUND, groupView } from '#lib/groups/server/context.js';

// Writes as the group, so only someone who linked it gets the page.
export async function load({ params, locals }) {
	const group = await groupView(params.actor, locals);
	if (!group.linked) error(404, GROUP_NOT_FOUND);
	const { meta, listed } = group.linked;
	return {
		pageTitle: `Settings - ${group.name}`,
		group: { did: group.did, name: group.name },
		settings: {
			name: meta.profile?.name ?? group.name,
			description: meta.profile?.description ?? '',
			joinPolicy: meta.profile?.joinPolicy ?? 'invite',
			isPublic: meta.public,
			listed
		}
	};
}

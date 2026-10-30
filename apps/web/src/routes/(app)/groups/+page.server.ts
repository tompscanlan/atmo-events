import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { browseGroups } from '#lib/groups/server/browse.js';
import { groupSignInAvailable } from '#lib/groups/server/sign-in.js';

const LINK_NOTICES = {
	'not-here': 'That is not a group at this site’s group host.',
	failed: 'The group was not linked. Only someone with a role in the group can link it.'
} as const;

export async function load({ locals, url }) {
	if (!env.GROUP_HOST_URL) error(404, 'Not found');
	const { groups, declaredUnavailable, askAccess } = await browseGroups(locals);
	const link = url.searchParams.get('link');
	return {
		pageTitle: 'Groups',
		pageDescription: 'Groups on atmo and the events they host.',
		groups,
		declaredUnavailable,
		askAccess,
		canLink: Boolean(locals.did) && groupSignInAvailable(),
		signedIn: Boolean(locals.did),
		notice: link && link in LINK_NOTICES ? LINK_NOTICES[link as keyof typeof LINK_NOTICES] : null
	};
}

import { error } from '@sveltejs/kit';
import { browseGroups } from '#lib/groups/server/browse.js';
import { serverOrigin } from '#lib/groups/server/declared.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { groupSignInAvailable } from '#lib/groups/server/sign-in.js';

const LINK_NOTICES = {
	'not-here': 'That is not a group at this site’s group host.',
	failed: 'The group was not linked. Only someone with a role in the group can link it.'
} as const;

export async function load({ locals, url, setHeaders }) {
	// Linked groups lead the list, so it depends on who's asking.
	setHeaders({ 'cache-control': 'no-store' });
	requireGroupsEnabled();
	const asked = url.searchParams.get('server');
	const server = serverOrigin(asked);
	if (asked !== null && !server) error(404, 'Not found');
	const { groups, cursor, declaredUnavailable, crowded } = await browseGroups(locals.did, {
		cursor: url.searchParams.get('cursor'),
		server
	});
	const host = server ? new URL(server).host : null;
	const link = url.searchParams.get('link');
	return {
		pageTitle: host ? `Groups at ${host}` : 'Groups',
		pageDescription: 'Groups on atmo and the events they host.',
		groups,
		cursor,
		declaredUnavailable,
		server: server && host ? { origin: server, host } : null,
		crowded: crowded.map((entry) => ({ ...entry, host: new URL(entry.server).host })),
		canLink: Boolean(locals.did) && groupSignInAvailable(),
		signedIn: Boolean(locals.did),
		notice:
			link && Object.hasOwn(LINK_NOTICES, link)
				? LINK_NOTICES[link as keyof typeof LINK_NOTICES]
				: null
	};
}

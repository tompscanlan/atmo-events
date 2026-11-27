import { error } from '@sveltejs/kit';
import { browseDeclared, browseLinked, browseUpcoming } from '#lib/groups/server/browse.js';
import { searchTerm, serverOrigin } from '#lib/groups/server/declared.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { newGroupUrl } from '#lib/groups/server/host-api.js';
import { groupSignInAvailable } from '#lib/groups/server/sign-in.js';

const LINK_NOTICES = {
	'not-here': 'That is not a group at this site’s group host.',
	failed: 'The group was not linked. Only someone with a role in the group can link it.'
} as const;

export async function load({ locals, url, setHeaders }) {
	requireGroupsEnabled();
	// The caller's linked groups lead the list, so it depends on who's asking.
	setHeaders({ 'cache-control': 'no-store' });
	const asked = url.searchParams.get('server');
	const server = serverOrigin(asked);
	if (asked !== null && !server) error(404, 'Not found');
	const q = searchTerm(url.searchParams.get('q'));
	const cursor = url.searchParams.get('cursor');
	// One server's groups, or a search's, newest first; otherwise those with an event coming.
	const declared = Boolean(server || q);
	const canLink = Boolean(locals.did) && groupSignInAvailable();
	// The person's linked groups lead the whole list's first page.
	const firstPage = !declared && !cursor;
	const [upcoming, found, linked] = await Promise.all([
		declared ? null : browseUpcoming(cursor),
		declared ? browseDeclared({ cursor, server, q }) : null,
		firstPage && locals.did ? browseLinked(locals.did) : []
	]);
	const host = server ? new URL(server).host : null;
	const link = url.searchParams.get('link');
	return {
		pageTitle: host ? `Groups at ${host}` : 'Groups',
		pageDescription: 'Groups on atmo and the events they host.',
		server: server && host ? { origin: server, host } : null,
		/** What was searched for, as searched; null for no search. */
		q,
		/** The groups with an event coming, on the whole list. */
		upcoming: upcoming?.groups ?? [],
		/** On its first page: every server with declared groups, and its counts. */
		servers: upcoming?.servers ?? [],
		/** One server's groups, or a search's. */
		groups: found?.groups ?? [],
		cursor: (upcoming ?? found)?.cursor ?? null,
		unavailable: Boolean((upcoming ?? found)?.unavailable),
		canLink,
		/** Where a group is made: the group host's own page. */
		newGroupUrl: newGroupUrl(),
		signedIn: Boolean(locals.did),
		/** The groups the caller has linked, by this site's record of their links, private and
		 *  unlisted ones too. */
		linked,
		notice:
			link && Object.hasOwn(LINK_NOTICES, link)
				? LINK_NOTICES[link as keyof typeof LINK_NOTICES]
				: null
	};
}

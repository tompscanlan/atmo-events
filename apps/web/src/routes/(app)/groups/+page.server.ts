import { error } from '@sveltejs/kit';
import { groupAccess } from '#lib/groups/permissions-asked.js';
import { holdsParticipate } from '#lib/groups/scopes.js';
import {
	browseDeclared,
	browseLinked,
	browseUpcoming,
	yourGroups
} from '#lib/groups/server/browse.js';
import { unfinishedGroups } from '#lib/groups/server/create.js';
import { searchTerm, serverOrigin } from '#lib/groups/server/declared.js';
import { CREATE_IN_THIS_BUILD } from '#lib/groups/build.js';
import { requireGroupsEnabled } from '#lib/groups/server/enabled.js';
import { newGroupUrl } from '#lib/groups/server/host-api.js';
import { groupSignInAvailable } from '#lib/groups/server/sign-in.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { spacesServer } from '#lib/private-events/server/enabled.js';

const LINK_NOTICES = {
	'not-here': 'That is not a group at this site’s group host.',
	failed: 'The group was not linked. Only someone with a role in the group can link it.'
} as const;

export async function load({ locals, url, setHeaders }) {
	requireGroupsEnabled();
	// The caller's own groups and linked ones lead the list, so it depends on who's asking.
	setHeaders({ 'cache-control': 'no-store' });
	const asked = url.searchParams.get('server');
	const server = serverOrigin(asked);
	if (asked !== null && !server) error(404, 'Not found');
	const q = searchTerm(url.searchParams.get('q'));
	const cursor = url.searchParams.get('cursor');
	// One server's groups, or a search's, newest first; otherwise those with an event coming.
	const declared = Boolean(server || q);
	const canLink = Boolean(locals.did) && groupSignInAvailable();
	// The person's own groups lead the whole list's first page.
	const firstPage = !declared && !cursor;
	const person = firstPage && locals.did ? await callerSession(locals.session ?? null) : null;
	const [upcoming, found, unfinished, own, linked] = await Promise.all([
		declared ? null : browseUpcoming(cursor),
		declared ? browseDeclared({ cursor, server, q }) : null,
		CREATE_IN_THIS_BUILD && canLink && locals.did ? unfinishedGroups(locals.did) : [],
		person ? yourGroups(person) : null,
		firstPage && locals.did ? browseLinked(locals.did) : []
	]);
	// A group in "Your groups" is shown there only.
	const ownDids = new Set((own ?? []).map((group) => group.did));
	const access = person && !holdsParticipate(person.scope) ? groupAccess(url, person.did) : null;
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
		/** Where a group is made, in a build without making them here: the group host's own page. */
		newGroupUrl: CREATE_IN_THIS_BUILD ? null : newGroupUrl(),
		/** Groups the caller made here and has not linked yet; none in a build without making them. */
		unfinished: unfinished.length,
		signedIn: Boolean(locals.did),
		you: locals.did,
		/** The groups the caller is in, at this site's group host; null when not asked. */
		yourGroups: own,
		/** The groups the caller has linked, by this site's record of their links, private and
		 *  unlisted ones too, but for those in yourGroups. */
		linked: linked.filter((group) => !ownDids.has(group.did)),
		/** What the caller's own sign-in needs to list their groups and join others. */
		access,
		spacesServer: access === 'refused' ? spacesServer() : null,
		notice:
			link && Object.hasOwn(LINK_NOTICES, link)
				? LINK_NOTICES[link as keyof typeof LINK_NOTICES]
				: null
	};
}

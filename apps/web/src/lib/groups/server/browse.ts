// The groups list. By default, the groups with an event coming, soonest first, a page at a time
// and at most 15 of one server's on a page, then each server with its counts, leading to that
// server's own list of every group it has. A search finds declared groups by handle, or by name
// where this site has cached it, across all servers or within one. Names come from the cached
// group profiles; a group without one shows the handle the index holds for it. All of it is read
// from the database, with no call to another server.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { ACTOR_GROUPS_NSID, holdsRpc } from '../scopes';
import { serverOrigin } from './declared';
import { listDeclaredGroups, listGroupServers, listUpcomingGroups, readGroupLabels } from './group';
import { actorGroups } from './host';
import { errorKind } from './xrpc';

export interface UpcomingEntry {
	did: string;
	name: string;
	handle: string | null;
	next: { title: string; startsAt: string };
}

export interface ServerEntry {
	/** Its origin, which names its own list. */
	server: string;
	/** What the list calls it. */
	host: string;
	groups: number;
	upcoming: number;
}

export interface UpcomingPage {
	groups: UpcomingEntry[];
	/** For the next page; null on the last. */
	cursor: string | null;
	/** On the first page: every server with declared groups. */
	servers: ServerEntry[];
	/** The index did not answer. */
	unavailable: boolean;
}

/** One page of the groups with an event coming; on the first, the servers too. */
export async function browseUpcoming(cursor: string | null = null): Promise<UpcomingPage> {
	const [page, servers] = await Promise.all([
		listUpcomingGroups(cursor).catch((e) => {
			console.error('[groups] the groups with events coming could not be read:', e);
			return null;
		}),
		cursor
			? []
			: listGroupServers().catch((e) => {
					console.error('[groups] the group servers could not be read:', e);
					return [];
				})
	]);
	return {
		groups: (page?.groups ?? []).map(({ did, name, handle, next }) => ({
			did,
			name: name ?? handle ?? did,
			handle,
			next: { title: next.title, startsAt: next.startsAt }
		})),
		cursor: page?.cursor ?? null,
		servers: servers.flatMap(({ server, groups, upcoming }) => {
			// A server the list could not link to its own page is left out.
			const origin = serverOrigin(server);
			return origin ? [{ server: origin, host: new URL(origin).host, groups, upcoming }] : [];
		}),
		unavailable: page === null
	};
}

export interface BrowseEntry {
	did: string;
	name: string;
	handle: string | null;
	description: string | null;
}

export interface DeclaredPage {
	groups: BrowseEntry[];
	/** For the next page; null on the last. */
	cursor: string | null;
	/** The index did not answer. */
	unavailable: boolean;
}

/** One page of declared groups, newest first: one server's with `server`, those a search finds
 *  with `q`, or both. */
export async function browseDeclared({
	cursor = null,
	server = null,
	q = null
}: {
	cursor?: string | null;
	server?: string | null;
	q?: string | null;
}): Promise<DeclaredPage> {
	let page: Awaited<ReturnType<typeof listDeclaredGroups>>;
	try {
		page = await listDeclaredGroups({ cursor, server, q });
	} catch (e) {
		console.error('[groups] the declaration index did not answer:', e);
		return { groups: [], cursor: null, unavailable: true };
	}
	const labels = await readGroupLabels(page.dids).catch((e) => {
		console.error('[groups] the groups could not be named from the database:', e);
		return new Map<string, never>();
	});
	return {
		groups: page.dids.map((did) => {
			const label = labels.get(did);
			const handle = label?.handle ?? null;
			return {
				did,
				name: label?.name ?? handle ?? did,
				handle,
				description: label?.description ?? null
			};
		}),
		cursor: page.cursor,
		unavailable: false
	};
}

export interface OwnGroup {
	did: string;
	name: string;
	handle: string;
}

/** "Your groups": the groups the person is in at this site's group host, by the host's own list,
 *  named as the host shows them to a member. Null when their sign-in cannot ask for it, or the host
 *  did not answer. */
export async function yourGroups(caller: CallerSession): Promise<OwnGroup[] | null> {
	if (!holdsRpc(caller.scope, ACTOR_GROUPS_NSID)) return null;
	try {
		const groups = await actorGroups(caller);
		return groups.map(({ did, handle, displayName }) => ({
			did,
			name: displayName ?? handle,
			handle
		}));
	} catch (e) {
		console.error(`[groups] ${caller.did}'s groups could not be listed: ${errorKind(e)}`);
		return null;
	}
}

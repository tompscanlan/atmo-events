// The groups list. By default, the groups with an event coming, soonest first, a page at a time
// and at most 15 of one server's on a page, then each server with its counts, leading to that
// server's own list of every group it has. A search finds declared groups by handle, or by name
// where this site has cached it, across all servers or within one. Names come from the cached
// group profiles; a group without one shows the handle the index holds for it. All of it is read
// from the database, with no call to another server but for a linked group the database knows
// nothing of. A signed-in person's linked groups lead the list, for them alone.
import { serverOrigin } from './declared';
import {
	heldOf,
	listDeclaredGroups,
	listGroupServers,
	listUpcomingGroups,
	readGroupLabels,
	resolveGroup
} from './group';
import { linkedGroups } from './sign-in';

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
		// This site's group host's own list: only the accounts it holds, of those that name it.
		if (server) page = { ...page, dids: await heldOf(server, page.dids) };
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

/** The groups the person has linked, from this site's own record of their links, private and
 *  unlisted ones too, for that person only. Named from the database; a group it has neither a
 *  name nor a handle for, as an unlisted one may be, is worth one lookup. */
export async function browseLinked(personDid: string): Promise<BrowseEntry[]> {
	const dids = await linkedGroups(personDid).catch((e) => {
		console.error(`[groups] ${personDid}'s linked groups could not be listed:`, e);
		return [];
	});
	if (dids.length === 0) return [];
	const labels = await readGroupLabels(dids).catch((e) => {
		console.error('[groups] the linked groups could not be named from the database:', e);
		return new Map<string, never>();
	});
	return Promise.all(
		dids.map(async (did) => {
			const label = labels.get(did);
			const handle =
				label?.handle ?? (label?.name ? null : ((await resolveGroup(did))?.handle ?? null));
			return {
				did,
				name: label?.name ?? handle ?? did,
				handle,
				description: label?.description ?? null
			};
		})
	);
}

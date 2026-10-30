// The groups list: declared groups, newest first, a page at a time, at most 20 from each server
// but this site's group host, and on the first page before them the groups the caller linked.
// A server's other groups are on a page of their own. Names come from the cards; a group without
// one shows its handle.
import type { CrowdedServer } from './declared';
import { listCrowdedServers, listDeclaredGroups, readCards, resolveGroup } from './group';
import { linkedGroups } from './sign-in';

export interface BrowseEntry {
	did: string;
	name: string;
	handle: string | null;
	description: string | null;
	linked: boolean;
}

export interface BrowsePage {
	groups: BrowseEntry[];
	/** For the next page of declared groups; null on the last. */
	cursor: string | null;
	/** The index did not answer; linked groups still show. */
	declaredUnavailable: boolean;
	/** On the first page of the whole list: the servers it shows only some groups of. */
	crowded: CrowdedServer[];
}

/** `server` is one server's page: all its groups, and no linked ones put first. */
export async function browseGroups(
	callerDid: string | null,
	{ cursor = null, server = null }: { cursor?: string | null; server?: string | null } = {}
): Promise<BrowsePage> {
	const firstPage = !cursor && !server;
	const [declared, allLinked, crowded] = await Promise.all([
		listDeclaredGroups({ cursor, server }).catch((e) => {
			console.error('[groups] the declaration index did not answer:', e);
			return null;
		}),
		callerDid ? linkedGroups(callerDid) : Promise.resolve([]),
		firstPage
			? listCrowdedServers().catch((e) => {
					console.error('[groups] the crowded servers could not be read:', e);
					return [];
				})
			: Promise.resolve([])
	]);

	// Linked groups lead the whole list's first page and are left out of its declared ones.
	const linkedSet = new Set(allLinked);
	const linked = firstPage ? allLinked : [];
	const declaredDids = (declared?.groups ?? []).map((d) => d.did);
	const dids = [
		...linked,
		...(server ? declaredDids : declaredDids.filter((did) => !linkedSet.has(did)))
	];
	const cards = await readCards(dids);

	// A linked group may be unlisted, so it can lack a card; its handle is worth one lookup.
	const handles = new Map<string, string | null>();
	await Promise.all(
		linked
			.filter((did) => !cards.has(did))
			.map(async (did) => handles.set(did, (await resolveGroup(did))?.handle ?? null))
	);

	const groups = dids.map((did): BrowseEntry => {
		const card = cards.get(did);
		const handle = card?.handle ?? handles.get(did) ?? null;
		return {
			did,
			name: card?.name ?? handle ?? did,
			handle,
			description: card?.description ?? null,
			linked: linkedSet.has(did)
		};
	});
	return {
		groups,
		cursor: declared?.cursor ?? null,
		declaredUnavailable: declared === null,
		crowded
	};
}

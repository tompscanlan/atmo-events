// The groups list: every declared group, newest first, a page at a time, and on the first
// page before them the groups the caller linked. Names come from the cards; a group without
// one shows its handle.
import { listDeclaredGroups, readCards, resolveGroup } from './group';
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
}

export async function browseGroups(
	callerDid: string | null,
	cursor: string | null = null
): Promise<BrowsePage> {
	const [declared, allLinked] = await Promise.all([
		listDeclaredGroups(cursor).catch((e) => {
			console.error('[groups] the declaration index did not answer:', e);
			return null;
		}),
		callerDid ? linkedGroups(callerDid) : Promise.resolve([])
	]);

	// Linked groups lead the first page and are left out of every page's declared ones.
	const linkedSet = new Set(allLinked);
	const linked = cursor ? [] : allLinked;
	const dids = [
		...linked,
		...(declared?.groups ?? []).map((d) => d.did).filter((did) => !linkedSet.has(did))
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
	return { groups, cursor: declared?.cursor ?? null, declaredUnavailable: declared === null };
}

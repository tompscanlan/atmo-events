// The groups list: every declared group, newest first, and before them the groups the
// caller linked. Names come from the cards; a group without one shows its handle.
import { listDeclaredGroups, readCards, resolveGroup } from './group';
import { linkedGroups } from './sign-in';

export interface BrowseEntry {
	did: string;
	name: string;
	handle: string | null;
	description: string | null;
	linked: boolean;
}

/** `declaredUnavailable` when the index did not answer; linked groups still show. */
export async function browseGroups(
	callerDid: string | null
): Promise<{ groups: BrowseEntry[]; declaredUnavailable: boolean }> {
	const [declared, linked] = await Promise.all([
		listDeclaredGroups().catch((e) => {
			console.error('[groups] the declaration index did not answer:', e);
			return null;
		}),
		callerDid ? linkedGroups(callerDid) : Promise.resolve([])
	]);

	const linkedSet = new Set(linked);
	const dids = [...new Set([...linked, ...(declared ?? []).map((d) => d.did)])];
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
	return { groups, declaredUnavailable: declared === null };
}

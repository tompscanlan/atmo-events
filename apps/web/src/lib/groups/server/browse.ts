// The groups list: every declared group, newest first, and before them the caller's own:
// the groups they linked and the groups they belong to. Names come from the caller's own
// read for their groups and from the cards for the rest; a group without either shows its
// handle.
import { holdsGroupScopes } from '../scopes';
import { callerSession } from './caller';
import type { Viewer } from './context';
import { listDeclaredGroups, readCards, resolveGroup, type GroupProfile } from './group';
import { groupsOfPerson } from './person';
import { linkedGroups } from './sign-in';

export interface BrowseEntry {
	did: string;
	name: string;
	handle: string | null;
	description: string | null;
	linked: boolean;
	member: boolean;
}

/** `declaredUnavailable` when the index did not answer; the caller's own groups still show. */
export async function browseGroups(
	viewer: Viewer
): Promise<{ groups: BrowseEntry[]; declaredUnavailable: boolean; askAccess: boolean }> {
	const caller = await callerSession(viewer.session ?? null);
	const [declared, linked, own] = await Promise.all([
		listDeclaredGroups().catch((e) => {
			console.error('[groups] the declaration index did not answer:', e);
			return null;
		}),
		viewer.did ? linkedGroups(viewer.did) : Promise.resolve([]),
		caller && holdsGroupScopes(caller.scope)
			? groupsOfPerson(caller).catch((e) => {
					console.warn(`[groups] ${caller.did}'s groups could not be listed:`, e);
					return [];
				})
			: Promise.resolve([])
	]);

	const linkedSet = new Set(linked);
	const read = new Map<string, GroupProfile>();
	for (const group of own) if (group.meta.profile) read.set(group.did, group.meta.profile);
	const memberSet = new Set(own.map((group) => group.did));

	const yours = [...new Set([...linked, ...memberSet])];
	const dids = [...new Set([...yours, ...(declared ?? []).map((d) => d.did)])];
	const cards = await readCards(dids.filter((did) => !read.has(did)));

	// One of the caller's groups may be unlisted, so it can lack a card; its handle is worth
	// one lookup.
	const handles = new Map<string, string | null>();
	await Promise.all(
		yours
			.filter((did) => !cards.has(did))
			.map(async (did) => handles.set(did, (await resolveGroup(did))?.handle ?? null))
	);

	const groups = dids.map((did): BrowseEntry => {
		const card = cards.get(did);
		const profile = read.get(did) ?? card;
		const handle = card?.handle ?? handles.get(did) ?? null;
		return {
			did,
			name: profile?.name ?? handle ?? did,
			handle,
			description: profile?.description ?? null,
			linked: linkedSet.has(did),
			member: memberSet.has(did)
		};
	});
	return {
		groups,
		declaredUnavailable: declared === null,
		askAccess: caller !== null && !holdsGroupScopes(caller.scope)
	};
}

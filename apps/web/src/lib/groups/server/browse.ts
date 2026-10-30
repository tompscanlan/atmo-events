// The groups list: declared groups, newest first, a page at a time, at most 20 from each server
// but this site's group host, and on the first page before them the caller's own: the groups they
// linked and the groups they belong to. A server's other groups are on a page of their own. Names
// come from the caller's own read for their groups and from the cards for the rest; a group
// without either shows its handle.
import { holdsGroupScopes } from '../scopes';
import { callerSession } from './caller';
import type { Viewer } from './context';
import type { CrowdedServer } from './declared';
import {
	listCrowdedServers,
	listDeclaredGroups,
	readCards,
	resolveGroup,
	type GroupProfile
} from './group';
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

export interface BrowsePage {
	groups: BrowseEntry[];
	/** For the next page of declared groups; null on the last. */
	cursor: string | null;
	/** The index did not answer; the caller's own groups still show. */
	declaredUnavailable: boolean;
	/** On the first page of the whole list: the servers it shows only some groups of. */
	crowded: CrowdedServer[];
	/** Signed in without group permissions, so their own groups could not be read. */
	askAccess: boolean;
}

/** `server` is one server's page: all its groups, and none of the caller's own put first. */
export async function browseGroups(
	viewer: Viewer,
	{ cursor = null, server = null }: { cursor?: string | null; server?: string | null } = {}
): Promise<BrowsePage> {
	const firstPage = !cursor && !server;
	const caller = await callerSession(viewer.session ?? null);
	const [declared, allLinked, own, crowded] = await Promise.all([
		listDeclaredGroups({ cursor, server }).catch((e) => {
			console.error('[groups] the declaration index did not answer:', e);
			return null;
		}),
		viewer.did ? linkedGroups(viewer.did) : Promise.resolve([]),
		caller && holdsGroupScopes(caller.scope)
			? groupsOfPerson(caller).catch((e) => {
					console.warn(`[groups] ${caller.did}'s groups could not be listed:`, e);
					return [];
				})
			: Promise.resolve([]),
		firstPage
			? listCrowdedServers().catch((e) => {
					console.error('[groups] the crowded servers could not be read:', e);
					return [];
				})
			: Promise.resolve([])
	]);

	const linkedSet = new Set(allLinked);
	const read = new Map<string, GroupProfile>();
	for (const group of own) if (group.meta.profile) read.set(group.did, group.meta.profile);
	const memberSet = new Set(own.map((group) => group.did));

	// The caller's own groups lead the whole list's first page and are left out of its declared ones.
	const allYours = [...new Set([...allLinked, ...memberSet])];
	const yoursSet = new Set(allYours);
	const yours = firstPage ? allYours : [];
	const declaredDids = (declared?.groups ?? []).map((d) => d.did);
	const dids = [
		...yours,
		...(server ? declaredDids : declaredDids.filter((did) => !yoursSet.has(did)))
	];
	const cards = await readCards(dids.filter((did) => !read.has(did)));

	// One of the caller's groups may be unlisted, so it can lack a card; its handle is worth one
	// lookup.
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
		cursor: declared?.cursor ?? null,
		declaredUnavailable: declared === null,
		crowded,
		askAccess: caller !== null && !holdsGroupScopes(caller.scope)
	};
}

// The groups list: declared groups, newest first, a page at a time, at most 20 from each server
// but this site's group host, and on the first page before them the groups the caller linked.
// A server's other groups are on a page of their own. Names come from the cached group profiles;
// a group without one shows the handle the index holds for it.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { ACTOR_GROUPS_NSID, holdsRpc } from '../scopes';
import type { CrowdedServer } from './declared';
import {
	listCrowdedServers,
	listDeclaredGroups,
	readCachedHandles,
	readCachedProfiles,
	resolveGroup
} from './group';
import { actorGroups } from './host';
import { linkedGroups } from './sign-in';
import { errorKind } from './xrpc';

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
	const [profiles, indexed] = await Promise.all([
		readCachedProfiles(dids),
		readCachedHandles(dids).catch((e) => {
			console.error('[groups] the handles could not be read from the index:', e);
			return new Map<string, string>();
		})
	]);

	// A linked group may be unlisted, so neither may know it; its handle is worth one lookup.
	const handles = new Map<string, string | null>(indexed);
	await Promise.all(
		linked
			.filter((did) => !profiles.has(did) && !handles.has(did))
			.map(async (did) => handles.set(did, (await resolveGroup(did))?.handle ?? null))
	);

	const groups = dids.map((did): BrowseEntry => {
		const profile = profiles.get(did);
		const handle = profile?.handle ?? handles.get(did) ?? null;
		return {
			did,
			name: profile?.name ?? handle ?? did,
			handle,
			description: profile?.description ?? null,
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

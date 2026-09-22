import { knownHandles } from '$lib/groups/server/handles';
import { listGroups } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** Browse. Anonymous callers get public groups only; a signed-in caller also
 *  gets the groups they own or are on the roster of — the visibility filter
 *  lives in SQL (see `listGroups`) so the page cannot widen it by accident.
 *
 *  THE ONE SURFACE THAT RENDERS THE PROJECTION rather than records, and the
 *  reason is structural: the about space is never anonymously readable, so no
 *  indexer can read a group's name for us and a records-first list would be one
 *  session and one space read PER GROUP. `name` and `description` come from the
 *  Tier-1 columns every in-app profile writer keeps in step, and
 *  `rebuildGroupCache` repairs drift. No other column of the row is rendered
 *  here. (Spec: FR-010, the one bounded exception.)
 *
 *  Handles come from contrail's `identities` — the same cache every other
 *  actor's handle on this deployment comes from — and a group it has never
 *  resolved simply shows its DID, which is what the link carries anyway. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = platform!.env.DB;
	const groups = await listGroups(db, { callerDid: locals.did });
	const handles = await knownHandles(
		db,
		groups.map((group) => group.group_did)
	);
	return {
		groups: groups.map((group) => ({
			group_did: group.group_did,
			name: group.name,
			description: group.description,
			visibility: group.visibility,
			handle: handles.get(group.group_did) ?? null
		})),
		callerDid: locals.did
	};
};

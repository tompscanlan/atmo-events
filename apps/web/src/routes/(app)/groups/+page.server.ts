import { listDeclaredGroups } from '$lib/groups/server/declaration-index';
import { knownHandles } from '$lib/groups/server/handles';
import { listGroups } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

/** Browse. The list is the declaration index plus the caller's own groups (see
 *  `listGroups`). A group switched to private leaves browse when its
 *  declaration leaves the index, and a group declared by another app is listed
 *  beside ours.
 *
 *  This is the one page that shows the D1 copy rather than records. The about
 *  space is never anonymously readable, so no indexer can read a group's name
 *  for us, and reading records here would cost one session and one space read
 *  per group. `name` and `description` come from the columns every profile
 *  writer in the app keeps in step, and `rebuildGroupCache` repairs drift. A
 *  group with no row here has no name to show: it is listed by handle or DID,
 *  and not linked, because its page would 404.
 *
 *  Handles come from contrail's `identities` table, the same cache as every
 *  other actor's handle. A group it has never resolved shows its DID, which is
 *  what the link carries anyway. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const db = platform!.env.DB;
	const groups = await listGroups(db, {
		callerDid: locals.did,
		declared: await listDeclaredGroups(db)
	});
	const handles = await knownHandles(
		db,
		groups.map((group) => group.group_did)
	);
	return {
		groups: groups.map(({ group_did, row }) => ({
			group_did,
			hosted: row !== null,
			name: row?.name ?? null,
			description: row?.description ?? null,
			visibility: row?.visibility ?? null,
			handle: handles.get(group_did) ?? null
		})),
		callerDid: locals.did
	};
};

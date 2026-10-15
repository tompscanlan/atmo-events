import type { GroupVisibility } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { knownHandles } from '$lib/groups/server/identities';
import { listDeclaredGroups, listGroups } from '$lib/groups/server/browse';
/** Browse: the declaration index plus the caller's own groups (`listGroups`
 *  has the rules). Names come from the D1 rows, and no group's space is read
 *  (TS 2026-10-15). A group with no row is listed by handle or DID and not
 *  linked, since its page would 404. The badge is placement: a declared group
 *  is public, any other is private. */
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
		groups: groups.map(({ group_did, row, declared }) => ({
			group_did,
			hosted: row !== null,
			name: row?.name ?? null,
			description: row?.description ?? null,
			visibility: (declared ? 'public' : 'private') satisfies GroupVisibility,
			handle: handles.get(group_did) ?? null
		})),
		callerDid: locals.did
	};
};

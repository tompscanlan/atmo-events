import type { PageServerLoad } from './$types';
import { knownHandles } from '$lib/groups/server/identities';
import { listDeclaredGroups, listGroups } from '$lib/groups/server/browse';
/** The declaration index plus the caller's own groups. Names come from the rows; a
 *  group with no row is listed by handle or DID, unlinked, since its page would 404. */
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
			listed: declared,
			handle: handles.get(group_did) ?? null
		})),
		callerDid: locals.did
	};
};

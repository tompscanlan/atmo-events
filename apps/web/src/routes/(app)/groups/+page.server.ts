import { groupSpaceReader, type GroupSpaceReader } from '$lib/groups/server/about-read';

import type { GroupVisibility } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { knownHandles } from '$lib/groups/server/identities';
import { listDeclaredGroups, listGroups } from '$lib/groups/server/browse';
import { readStanding } from '$lib/groups/server/standing';
/** Browse: the declaration index plus the caller's own groups (`listGroups`
 *  has the rules). Names come from the D1 rows. A group with no row is listed
 *  by handle or DID and not linked, since its page would 404. The badge is
 *  placement: a declared group is public, any other is private. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const env = platform!.env;
	const db = env.DB;
	const groups = await listGroups(db, {
		callerDid: locals.did,
		declared: await listDeclaredGroups(db),
		onRoster: async (row) => {
			// A reader that cannot be built confirms nobody, as in `readStanding`.
			// A null reader means no credential, and then the row answers.
			let reader: GroupSpaceReader | null;
			try {
				reader = await groupSpaceReader(env, row);
			} catch (e) {
				console.error(
					`[groups] ${row.group_did}: no members-space reader for browse; the group is left out:`,
					e
				);
				return false;
			}
			return (await readStanding(db, row, locals.did, reader)).onRoster;
		}
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

import { groupSpaceReader } from '$lib/groups/server/about-read';
import { listDeclaredGroups } from '$lib/groups/server/declaration-index';
import { knownHandles } from '$lib/groups/server/handles';
import { listGroups } from '$lib/groups/server/repo';
import { readStanding } from '$lib/groups/server/route-context';
import type { GroupVisibility } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

/** Browse. The list is the declaration index plus the caller's own groups (see
 *  `listGroups`). A group switched to private leaves browse when its
 *  declaration leaves the index, which the withdrawal tells at once, and a
 *  group declared by another app is listed beside ours.
 *
 *  This is the one page that shows the D1 copy rather than records. The about
 *  space is never anonymously readable, so no indexer can read a group's name
 *  for us, and reading records here would cost one session and one space read
 *  per group. `name` and `description` come from the columns every profile
 *  writer in the app keeps in step, and `rebuildGroupCache` repairs drift. A
 *  group with no row here has no name to show: it is listed by handle or DID,
 *  and not linked, because its page would 404.
 *
 *  The exception is an undeclared group the caller reaches only through a
 *  membership row and does not own. Its row may be the trace of a removal
 *  whose row delete failed, so the caller's membership record is read, the
 *  same standing the group page gates on. Each such check costs a credential
 *  decrypt, a group session (a login on the first use in an isolate, cached
 *  after), 4 members-space reads and 3 D1 reads. Only a signed-in caller pays
 *  it, and `listGroups` bounds it: newest first, at most 6 at once, and no
 *  more than the page's limit plus the rejections along the way.
 *
 *  The visibility badge is placement, with no host read per row: a group from
 *  the declaration index is public, and one the caller sees only through
 *  their own groups, undeclared, is private.
 *
 *  Handles come from contrail's `identities` table, the same cache as every
 *  other actor's handle. A group it has never resolved shows its DID, which is
 *  what the link carries anyway. */
export const load: PageServerLoad = async ({ locals, platform }) => {
	const env = platform!.env;
	const db = env.DB;
	const groups = await listGroups(db, {
		callerDid: locals.did,
		declared: await listDeclaredGroups(db),
		onRoster: async (row) => {
			// A reader that cannot be built is a read that failed, and the row
			// answers it, as `readStanding` answers a members space that errors.
			const reader = await groupSpaceReader(env, db, row).catch((e) => {
				console.error(`[groups] ${row.group_did}: no members-space reader for browse:`, e);
				return null;
			});
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

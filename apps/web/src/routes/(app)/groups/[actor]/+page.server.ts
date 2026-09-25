import { canSeeMembers } from '$lib/groups/access';
import { groupFace } from '$lib/groups/about-record';
import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { countActiveMembers, listJoinRequests } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	// Takes a DID or a full handle, and refuses with the same 404 a form gets.
	const { group, membership } = await groupRouteContext(
		platform!.env,
		db,
		params.actor,
		locals.did
	);

	// The join-request queue is the admit decision, so it needs the admit grant,
	// not a general "manages members" flag that would also cover ejecting and
	// role changes.
	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	// The group's public face comes from records. A missing record and a failed
	// read are different cases, and only the first falls back:
	//
	//   ABSENT record  -> render the row and say so. A group with an empty about
	//                     space still gets a page instead of a blank one.
	//   FAILED read    -> the page fails. There is no cache fallback for an
	//                     outage: a row that quietly stands in for a record the
	//                     PDS refused is how a stale name becomes permanent.
	//
	// `groupSpaceReader` returns null when this deployment holds no credential
	// for the group, which is the absent case, not a failure. A throw from
	// `readGroupAbout` is the failure, and it is not caught on purpose.
	const reader = await groupSpaceReader(platform!.env, db, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	return {
		group,
		membership,
		/** The handle the group's own PDS reports, verified both ways, or null (then
		 *  the page shows the DID). Display only: nothing keys on it. */
		handle: await refreshGroupHandle(db, group.group_did),
		/** The rendered name, description and location, plus `source`: where they
		 *  came from, so the page can say whether it read records. */
		about: {
			/** Every field from the profile record when there is one, its nulls
			 *  included, and from the row only when there is not. The join policy
			 *  is the record's, which is what the group published. */
			...groupFace(about.profile, group),
			rules: about.rules.map((rule) => ({ text: rule.text, uri: rule.uri }))
		},
		memberCount: await countActiveMembers(db, group.id),
		// Only an ADMIT_MEMBERS holder is shown the queue; everyone else gets [].
		pendingRequests: canAdmitMembers ? await listJoinRequests(db, group.id, 'pending') : [],
		canManageGroup: can(membership.permissions, 'MANAGE_GROUP'),
		canAdmitMembers,
		canSeeMembers: canSeeMembers(membership),
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT')
	};
};

import { canSeeMembers } from '$lib/groups/access';
import { groupFace } from '$lib/groups/about-record';
import { can } from '$lib/groups/permissions';
import {
	groupSpaceReader,
	readGroupAbout,
	type GroupSpaceReader
} from '$lib/groups/server/about-read';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { countActiveMembers, listJoinRequests } from '$lib/groups/server/repo';
import { readGroupVisibility } from '$lib/groups/server/spaces';
import type { GroupRow, GroupVisibility } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

/** The visibility the page shows, in its badge and as the settings form's
 *  selected value: the host's, the about space's read policy, since the row
 *  holds none.
 *
 *  The gate already asked the host for a caller off the roster, and that
 *  answer is reused. For a caller on the roster the gate did not ask, so the
 *  page does. A host that does not answer then leaves the page without a
 *  visibility (null) rather than failing it, which is why the gate skips the
 *  host for members: a host that is down must not lock them out. `null` too
 *  when this deployment holds no credential to ask with. */
async function hostVisibility(
	gate: GroupVisibility | null,
	reader: GroupSpaceReader | null,
	group: GroupRow
): Promise<GroupVisibility | null> {
	if (gate) return gate;
	if (!reader) return null;
	try {
		return await readGroupVisibility(reader, group);
	} catch (e) {
		console.error(`[groups] ${group.group_did}: the about space's read policy did not answer:`, e);
		return null;
	}
}

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	// Takes a DID or a full handle, and refuses with the same 404 a form gets.
	const {
		group,
		membership,
		visibility: gateVisibility
	} = await groupRouteContext(platform!.env, db, params.actor, locals.did);

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
	const [about, visibility] = await Promise.all([
		reader ? readGroupAbout(reader, group) : { profile: null, rules: [] },
		hostVisibility(gateVisibility, reader, group)
	]);

	return {
		group,
		membership,
		/** The group's visibility as its host reports it, or null when the host
		 *  could not be asked (`hostVisibility`). */
		visibility,
		/** The handle the group's own PDS reports, verified both ways, or null (then
		 *  the page shows the DID). Display only: nothing keys on it. */
		handle: await refreshGroupHandle(db, group.group_did),
		/** The rendered name, description and location, plus `source`: where they
		 *  came from, so the page can say whether it read records. */
		about: {
			/** Every field from the profile record when there is one, its nulls
			 *  included, and from the row only when there is not. The join policy
			 *  is derived: the record's, or else the row's approval, only for a
			 *  public host; invite-only for a private one or one that could not
			 *  be asked (`groupFace`). */
			...groupFace(about.profile, group, visibility),
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

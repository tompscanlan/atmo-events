import { canSeeMembers } from '$lib/groups/access';
import { joinPolicyFor } from '$lib/groups/about-record';
import { can } from '$lib/groups/permissions';
import { groupSpaceReader, readGroupAbout } from '$lib/groups/server/about-read';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { countActiveMembers, listJoinRequests } from '$lib/groups/server/repo';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals, platform }) => {
	const db = platform!.env.DB;
	// DID or full handle in, one 404 out — and the same one a form answers.
	const { group, membership } = await groupRouteContext(db, params.actor, locals.did);

	// The queue is the admit decision, so it is the admit grant — not a general
	// "manages members" flag that would also cover ejecting and role changes.
	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	// THE GROUP'S PUBLIC FACE COMES FROM RECORDS. Not "records or nothing", and
	// not "records unless something goes wrong" either — the two cases are
	// different and only one of them falls back:
	//
	//   ABSENT record  -> render the row and SAY SO. A group provisioned before
	//                     the profile writer existed has an empty about space,
	//                     and a page that blanked for it would be worse.
	//   FAILED read    -> the page fails. There is no cache fallback for an
	//                     outage: a row that quietly stands in for a record the
	//                     PDS refused is how a stale name becomes permanent.
	//
	// `groupSpaceReader` returns null when this deployment holds no credential
	// for the group, which is the absent case, not a failure. A throw from
	// `readGroupAbout` is the failure, and it is deliberately not caught.
	// (Spec: FR-010, ruled 2026-09-21.)
	const reader = await groupSpaceReader(platform!.env, db, group);
	const about = reader ? await readGroupAbout(reader, group) : { profile: null, rules: [] };

	return {
		group,
		membership,
		/** The handle its own PDS reports, verified both ways, or null — in which
		 *  case the page shows the DID. Display only: nothing keys on it. */
		handle: await refreshGroupHandle(db, group.group_did),
		/** Where the rendered name/description/location actually came from, so
		 *  the page can say so rather than leaving it ambiguous — and so SC-002
		 *  is observable in a browser rather than only in a test. */
		about: {
			source: about.profile ? ('records' as const) : ('cache' as const),
			name: about.profile?.name ?? group.name,
			description: about.profile?.description ?? group.description,
			locationName: about.profile?.locationName ?? group.location_name,
			/** The RECORD's join policy, which is what the group published. The
			 *  columns are only consulted when there is no profile record to
			 *  read — `joinPolicyFor` is that derivation (FR-004b). */
			joinPolicy: about.profile?.joinPolicy ?? joinPolicyFor(group),
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

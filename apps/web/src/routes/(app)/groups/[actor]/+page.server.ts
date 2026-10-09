import { canSeeMembers } from '$lib/groups/access';
import { groupFace } from '$lib/groups/about-record';
import { can } from '$lib/groups/permissions';
import {
	groupSpaceReader,
	readGroupAbout,
	type GroupSpaceReader
} from '$lib/groups/server/about-read';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import {
	hasMemberRecords,
	readGroupMembers,
	rosterFromRecords,
	rosterFromRows
} from '$lib/groups/server/members-read';
import { loadPeople } from '$lib/groups/server/people';
import { hasLinkedSession } from '$lib/groups/server/linked-session';
import { groupRouteContext } from '$lib/groups/server/route-context';
import { countActiveMembers, listJoinRequests, listMembers } from '$lib/groups/server/repo';
import { readGroupVisibility } from '$lib/groups/server/spaces';
import type { GroupRow, GroupVisibility, RosterEntry } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

/** The visibility the page shows: the host's, since the row holds none. The
 *  gate's answer is reused. For a caller on the roster the gate did not ask,
 *  so the page does, and a host that does not answer gives null rather than
 *  failing the page. Also null with no credential to ask with. */
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

/** How many members the group page shows faces for. */
const ROSTER_PREVIEW = 8;

/** The roster the members tab shows, for a caller who may see it: records
 *  first, the rows only when the members space holds none. Null when the
 *  records cannot be read, so the page leaves the faces out rather than
 *  showing a copy the records may contradict. */
async function rosterPreview(
	reader: GroupSpaceReader | null,
	db: D1Database,
	group: GroupRow
): Promise<RosterEntry[] | null> {
	try {
		const members = reader ? await readGroupMembers(reader, group) : null;
		return members && hasMemberRecords(members)
			? rosterFromRecords(members)
			: rosterFromRows(await listMembers(db, group.id));
	} catch (e) {
		console.error(`[groups] ${group.group_did}: the members space did not answer:`, e);
		return null;
	}
}

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const db = platform!.env.DB;
	// Takes a DID or a full handle, and refuses with the same 404 a form gets.
	const {
		group,
		membership,
		visibility: gateVisibility
	} = await groupRouteContext(platform!.env, db, params.actor, locals.did);

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	// An absent record falls back to the row, so a group with an empty about
	// space still gets a page. A failed read fails the page: a row that quietly
	// stands in for a record the PDS refused is how a stale name becomes
	// permanent. A null reader (no credential) is the absent case.
	const reader = await groupSpaceReader(platform!.env, group);
	const showRoster = canSeeMembers(membership);
	const [about, visibility, roster, pendingRequests] = await Promise.all([
		reader ? readGroupAbout(reader, group) : { profile: null, rules: [] },
		hostVisibility(gateVisibility, reader, group),
		showRoster ? rosterPreview(reader, db, group) : null,
		canAdmitMembers ? listJoinRequests(db, group.id, 'pending') : []
	]);
	// The owner is on the roster, so only a caller who may see the roster sees
	// who it is: as the records name them, else the row's.
	const ownerDid = showRoster
		? (roster?.find((entry) => entry.role === 'owner')?.did ?? group.owner_did)
		: null;
	const preview = roster?.slice(0, ROSTER_PREVIEW) ?? [];
	const link = url.searchParams.get('link');
	const linkOutcome = link === 'linked' || link === 'failed' ? link : null;

	return {
		group,
		membership,
		/** The host's visibility, or null (`hostVisibility`). */
		visibility,
		/** The handle, verified both ways, or null. Display only: nothing keys on it. */
		handle: await refreshGroupHandle(db, group.group_did),
		about: {
			/** From the profile record when there is one, else the row. A private
			 *  or unknown visibility makes the join policy invite-only. */
			...groupFace(about.profile, group, visibility),
			rules: about.rules.map((rule) => ({ text: rule.text, uri: rule.uri }))
		},
		/** The roster's length when it was read; for a caller who cannot see
		 *  the roster, the rows' count. */
		memberCount: roster?.length ?? (await countActiveMembers(db, group.id)),
		/** The first members, for their faces. Empty for a caller who cannot see the roster. */
		rosterPreview: preview,
		/** Null for a caller who cannot see the roster. */
		ownerDid,
		pendingRequests,
		/** Avatar, name and handle for every DID the page shows. */
		people: await loadPeople(db, [
			...(ownerDid ? [ownerDid] : []),
			...preview.map((entry) => entry.did),
			...pendingRequests.map((request) => request.did)
		]),
		canManageGroup: can(membership.permissions, 'MANAGE_GROUP'),
		/** For the owner only, who alone may link the group's account: whether
		 *  this site writes as the group through a session the owner linked.
		 *  Null for anyone else. */
		groupLinked:
			locals.did && locals.did === group.owner_did
				? await hasLinkedSession(platform!.env, group.group_did)
				: null,
		/** How a link the owner just ran ended, from the link callback. */
		linkOutcome,
		canAdmitMembers,
		canSeeMembers: showRoster,
		canCreateEvent: can(membership.permissions, 'CREATE_EVENT')
	};
};

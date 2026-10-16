import { canSeeMembers } from '$lib/groups/access';
import { groupFace } from '$lib/groups/about-record';
import { mayHoldGroupSession } from '$lib/groups/grants';
import { can } from '$lib/groups/permissions';
import { readGroupAbout, type GroupSpaceReader } from '$lib/groups/server/about-read';
import { gateCaller } from '$lib/groups/server/acceptance';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import { readGroupMembers, NO_MEMBER_RECORDS } from '$lib/groups/server/members-read';
import { loadPeople } from '$lib/groups/server/people';

import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';

import { readGroupVisibility } from '$lib/groups/server/spaces';
import type { GroupRow, GroupVisibility, RosterEntry } from '$lib/groups/types';
import type { PageServerLoad } from './$types';

import { countMembers } from '$lib/groups/server/db/roster';
import { pendingRequestsFor } from '$lib/groups/server/host';
import { isHostGroup } from '$lib/groups/server/host-kind';
import { hasLinkedSession } from '$lib/groups/server/session';
/** The visibility the page shows: the about space's access record's, since the
 *  row holds none. The gate's answer is reused. For a caller on the roster the
 *  gate did not ask, so the page does, and a host that does not answer gives
 *  null rather than failing the page. Also null with no reader to ask with. */
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
		console.error(
			`[groups] ${group.group_did}: the about space's access record could not be read:`,
			e
		);
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
		const members = reader ? await readGroupMembers(reader, group) : NO_MEMBER_RECORDS;
		return (await pageRoster(db, group, members)).entries;
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
		visibility: gateVisibility,
		reader,
		signInOnly
	} = await groupRouteContext(db, params.actor, await gateCaller(locals.did, locals.session), {
		signInNotice: true
	});

	// A group hidden from the caller, such as a private group's creator right
	// after the create, whose sign-in carries no grant for it yet: the page says
	// only when a new sign-in opens it, under the row's name.
	if (signInOnly && membership.signIn) {
		const { groupName } = await groupHeader(db, group, null);
		return { signInOnly: true as const, group, groupName, signIn: membership.signIn };
	}

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');

	// An absent record falls back to the row, so a group with an empty about
	// space still gets a page. A failed read fails the page: a row that quietly
	// stands in for a record the PDS refused is how a stale name becomes
	// permanent. A null reader (nothing to read with) shows the row: the stored
	// name, description and location, and no rules (spec 003, Amendments
	// 2026-10-15).
	const showRoster = canSeeMembers(membership);
	const [about, visibility, roster, pendingRequests] = await Promise.all([
		reader ? readGroupAbout(reader, group) : { profile: null, rules: [] },
		hostVisibility(gateVisibility, reader, group),
		showRoster ? rosterPreview(reader, db, group) : null,
		canAdmitMembers
			? pendingRequestsFor({ db, env: platform!.env, group }, { callerDid: locals.did!, reader })
			: []
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
		signInOnly: false as const,
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
		memberCount: roster?.length ?? (await countMembers(db, group.id)),
		/** The first members, for their faces. Empty for a caller who cannot see the roster. */
		rosterPreview: preview,
		/** Null for a caller who cannot see the roster. */
		ownerDid,
		pendingRequests: pendingRequests ?? [],
		/** The viewer may admit, but holds no group session to ask the host with. */
		requestsNeedLink: pendingRequests === null,
		/** Avatar, name and handle for every DID the page shows. */
		people: await loadPeople(db, [
			...(ownerDid ? [ownerDid] : []),
			...preview.map((entry) => entry.did),
			...(pendingRequests ?? []).map((request) => request.did)
		]),
		canManageGroup: can(membership.permissions, 'MANAGE_GROUP'),
		/** Whether the group is at a real group host, where a link signs the person
		 *  in with their own account. Wording only, so a lookup that fails reads as
		 *  the stand-in. */
		atHost: await isHostGroup(platform!.env, group.group_did).catch(() => false),
		/** For someone whose roles grant writes, who may link a group session:
		 *  whether this site holds theirs, the one their writes as the group go
		 *  out on. Null for anyone else. */
		groupLinked:
			locals.did && mayHoldGroupSession(membership)
				? await hasLinkedSession(platform!.env, group.group_did, locals.did)
				: null,
		/** Why the page shows only the stored details, when nothing could be read
		 *  with the caller's access: they are signed out, or their sign-in reads
		 *  no spaces. Null when the page was read with their own access. */
		hiddenDetails: reader ? null : locals.did ? ('no-access' as const) : ('signed-out' as const),
		/** How a link the owner just ran ended, from the link callback. */
		linkOutcome,
		canAdmitMembers,
		canSeeMembers: showRoster
	};
};

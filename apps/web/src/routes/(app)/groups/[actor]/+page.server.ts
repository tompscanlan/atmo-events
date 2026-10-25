import { canSeeMembers } from '$lib/groups/access';
import { groupFace } from '$lib/groups/about-record';
import { mayHoldGroupSession } from '$lib/groups/grants';
import { can } from '$lib/groups/permissions';
import { readGroupAbout, type GroupSpaceReader } from '$lib/groups/server/about-read';
import { gateCaller } from '$lib/groups/server/caller';
import { publiclyDeclared } from '$lib/groups/server/declaration-writer';
import { refreshGroupHandle } from '$lib/groups/server/handles';
import { readGroupMembers, NO_MEMBER_RECORDS } from '$lib/groups/server/members-read';
import { loadPeople } from '$lib/groups/server/people';
import { groupHeader, groupRouteContext, pageRoster } from '$lib/groups/server/route-context';
import { readGroupVisibility } from '$lib/groups/server/spaces';
import {
	publicGroup,
	type GroupRow,
	type GroupVisibility,
	type RosterEntry
} from '$lib/groups/types';
import type { PageServerLoad } from './$types';
import { countMembers } from '$lib/groups/server/db/roster';
import { pendingRequestsFor } from '$lib/groups/server/host';
import { hasLinkedSession } from '$lib/groups/server/session';

/** The gate's answer when it asked; null when the host could not be asked. */
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
		console.error(`[groups] ${group.group_did}: the meta space's access could not be read:`, e);
		return null;
	}
}

const ROSTER_PREVIEW = 8;

/** Null when the members space did not answer, so the page shows no faces. */
async function rosterPreview(
	reader: GroupSpaceReader | null,
	db: D1Database,
	group: GroupRow
): Promise<RosterEntry[] | null> {
	try {
		const members = reader ? await readGroupMembers(reader, group) : NO_MEMBER_RECORDS;
		return await pageRoster(db, group, members);
	} catch (e) {
		console.error(`[groups] ${group.group_did}: the members space did not answer:`, e);
		return null;
	}
}

export const load: PageServerLoad = async ({ params, locals, platform, url }) => {
	const db = platform!.env.DB;
	const {
		group,
		membership,
		visibility: gateVisibility,
		reader,
		signInOnly
	} = await groupRouteContext(db, params.actor, await gateCaller(locals.did, locals.session), {
		signInNotice: true
	});

	if (signInOnly && membership.signIn) {
		const { groupName } = await groupHeader(db, group, null);
		return { signInOnly: true as const, group: publicGroup(group), groupName };
	}

	const canAdmitMembers = can(membership.permissions, 'ADMIT_MEMBERS');
	const canManageGroup = can(membership.permissions, 'MANAGE_GROUP');
	// A failed read fails the page, so the row never stands in for a record the PDS refused.
	const showRoster = canSeeMembers(membership);
	const [about, visibility, roster, pendingRequests, listed] = await Promise.all([
		reader ? readGroupAbout(reader, group) : { profile: null, rules: [] },
		hostVisibility(gateVisibility, reader, group),
		showRoster ? rosterPreview(reader, db, group) : null,
		canAdmitMembers
			? pendingRequestsFor({ db, env: platform!.env, group }, { callerDid: locals.did!, reader })
			: [],
		canManageGroup ? publiclyDeclared(db, group.group_did) : false
	]);
	const preview = roster?.slice(0, ROSTER_PREVIEW) ?? [];
	const link = url.searchParams.get('link');

	return {
		signInOnly: false as const,
		group: publicGroup(group),
		membership,
		visibility,
		listed,
		/** Verified both ways, or null. Display only. */
		handle: await refreshGroupHandle(db, group.group_did),
		about: {
			...groupFace(about.profile, group),
			rules: about.rules.map((rule) => ({ text: rule.text, uri: rule.uri }))
		},
		memberCount: roster?.length ?? (await countMembers(db, group.id)),
		rosterPreview: preview,
		pendingRequests: pendingRequests ?? [],
		/** The viewer may admit, but holds no group session to ask the host with. */
		requestsNeedLink: pendingRequests === null,
		people: await loadPeople(db, [
			...preview.map((entry) => entry.did),
			...(pendingRequests ?? []).map((request) => request.did)
		]),
		canManageGroup,
		/** Null for anyone whose roles grant no writes. */
		groupLinked:
			locals.did && mayHoldGroupSession(membership)
				? await hasLinkedSession(platform!.env, group.group_did, locals.did)
				: null,
		hiddenDetails: reader ? null : locals.did ? ('no-access' as const) : ('signed-out' as const),
		linkOutcome: link === 'linked' || link === 'failed' ? link : null,
		canAdmitMembers,
		canSeeMembers: showRoster
	};
};

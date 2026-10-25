// The one way into a group route. The pages and every group remote (../remote-context.ts)
// gate a group here, since a form with its own lookup could reveal a private
// group. Every refusal is the same 404, so a hidden group looks like one that
// never existed. The exceptions: a 503 when the host cannot say whether the
// group is private, since a 404 would hide a public group from its visitors;
// and, on a page that asks for it, a notice for a caller the row lists whose
// sign-in carries no grant for the group (`signInOnly`).
//
// Everything is read with the caller's own access: their
// standing, the visibility and every page read go through a reader built on
// their own session, so the group's authority decides what each person sees and
// no one's session reads for anyone else. A signed-out visitor has no reader:
// they see a group whose declaration is published, as the row and its public
// events show it (spec 003, Amendments 2026-10-15).
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility, RosterEntry } from '../types';
import { credentialSpaceReader, readGroupProfile, type GroupSpaceReader } from './about-read';
import type { MemberSession } from './acceptance';
import { publiclyDeclared } from './declaration-writer';
import { holdsMetaRead, memberGrantFrom, readsGroupSpaces } from './member-grants';
import { knownHandles } from './identities';

import {
	hasMemberRecords,
	rosterFromRecords,
	rosterFromRows,
	type GroupMembers
} from './members-read';
import { readGroupVisibility } from './spaces';

import { getGroupByDid } from './db/groups';
import { listMembers } from './db/roster';
import { readStanding } from './standing';
import { isSpaceAccessDenied } from './space-credential';
/** Every refusal says this, byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

export const GROUP_VISIBILITY_UNCHECKED = 'Group visibility could not be checked';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
	/** As the host reported it, so a form need not ask again. `null` when the
	 *  caller is on the roster, since the gate then does not ask. `public` for a
	 *  signed-out visitor, read off the declaration. */
	visibility: GroupVisibility | null;
	/** The caller's own reader, built once for the gate: every read on the page
	 *  goes through it. Null when there is no one to read as, a signed-out
	 *  visitor or a sign-in that reads no spaces, and then only what is public is
	 *  shown. */
	reader: GroupSpaceReader | null;
	/** The group would be hidden from the caller, but the row lists them and only
	 *  their own sign-in stands in the way (`membership.signIn`), as for a private
	 *  group's creator right after the create. Nothing of the group was read for
	 *  them, and `reader` is null: the page says only when a new sign-in opens it.
	 *  Set only when the route asked (`signInNotice`). */
	signInOnly?: true;
}

export interface GroupRouteOptions {
	/** The page can show the sign-in notice (`signInOnly`) in place of the 404. */
	signInNotice?: boolean;
}

/** The caller's own reader, or null when their sign-in reads no spaces: a PDS
 *  that serves none drops the grant, as does a sign-in from before it was asked
 *  for. */
export function callerReader(caller: MemberSession | null): GroupSpaceReader | null {
	return caller && holdsMetaRead(caller.scope) ? credentialSpaceReader(caller) : null;
}

/** `membership`, with `signIn` set when only a new sign-in stands between the
 *  caller and the roster: the row lists them, they are off the roster, and their
 *  sign-in carries no grant for the group, so the refusal was their own PDS's.
 *  A member whose sign-in does carry it was turned away by the host, and a new
 *  sign-in would not change that. */
export function withSignIn(
	membership: CallerMembership,
	group: GroupRow,
	caller: MemberSession | null,
	now: number
): CallerMembership {
	if (!caller || membership.onRoster || membership.role === null || membership.unreadable) {
		return membership;
	}
	if (!group.members_space_uri || readsGroupSpaces(caller.scope, group.group_did)) {
		return membership;
	}
	const from = memberGrantFrom(group);
	return { ...membership, signIn: { from: from > now ? from : null } };
}

/** A route key to a DID, or null. `actorToDid` cannot tell an unknown handle
 *  from a resolver outage, so an outage also answers 404 for a handle URL. */
export async function groupActorToDid(actor: string): Promise<string | null> {
	if (actor.startsWith('did:')) return actor;
	try {
		return await actorToDid(actor);
	} catch {
		return null;
	}
}

export async function groupRouteContext(
	db: D1Database,
	actor: string,
	caller: MemberSession | null,
	{ signInNotice = false }: GroupRouteOptions = {}
): Promise<GroupRouteContext> {
	const did = await groupActorToDid(actor);
	if (!did) error(404, GROUP_NOT_FOUND);

	const group = await getGroupByDid(db, did);
	if (!group) error(404, GROUP_NOT_FOUND);

	const reader = callerReader(caller);

	// A caller on the roster sees the group at every visibility, so the host is
	// not asked, and a failed visibility read cannot lock a member out.
	const membership = withSignIn(
		await readStanding(db, group, caller?.did ?? null, reader),
		group,
		caller,
		Date.now()
	);
	if (membership.onRoster) return { group, membership, visibility: null, reader };

	// The group is hidden from this caller. Someone the row lists whose sign-in
	// lacks the group was refused by their own PDS, not by the group, so a page
	// that can say so tells them when a new sign-in opens it. That reveals
	// nothing they do not hold: the row is their own. Anyone else gets the 404.
	const hidden = (): GroupRouteContext => {
		if (signInNotice && membership.signIn) {
			return { group, membership, visibility: null, reader: null, signInOnly: true };
		}
		error(404, GROUP_NOT_FOUND);
	};

	// No space can be read for this caller, so "public" is the declaration: a
	// group publishes one exactly while its meta space is public.
	if (!reader) {
		let declared: boolean;
		try {
			declared = await publiclyDeclared(group.group_did);
		} catch (e) {
			console.error(`[groups] ${group.group_did}: the declaration could not be read:`, e);
			error(503, GROUP_VISIBILITY_UNCHECKED);
		}
		if (!declared) return hidden();
		return { group, membership, visibility: 'public', reader };
	}

	// The authority's answer is the visibility: a private group does not let a
	// non-member into its meta space at all.
	let visibility: GroupVisibility;
	try {
		visibility = await readGroupVisibility(reader, group);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return hidden();
		console.error(
			`[groups] ${group.group_did}: the about space's access record could not be read:`,
			e
		);
		error(503, GROUP_VISIBILITY_UNCHECKED);
	}
	if (!canSeeGroup(visibility, membership)) return hidden();

	return { group, membership, visibility, reader };
}

/** A group page's header: the profile record's name, else the row's, and the
 *  handle Contrail knows, or null. A profile that cannot be read leaves the
 *  row's name in place rather than failing the page. */
export async function groupHeader(
	db: D1Database,
	group: GroupRow,
	reader: GroupSpaceReader | null
): Promise<{ groupName: string; handle: string | null }> {
	let profile = null;
	if (reader) {
		try {
			profile = await readGroupProfile(reader, group);
		} catch (e) {
			console.error(
				`[groups] ${group.group_did}: the profile could not be read; the header shows the row's name:`,
				e
			);
		}
	}
	const handles = await knownHandles(db, [group.group_did]);
	return { groupName: profile?.name ?? group.name, handle: handles.get(group.group_did) ?? null };
}

/** A page's roster: the membership records, or the rows when the members space
 *  holds none, since an empty space means the records were never written, not
 *  that the group has no members. `confirm` reads which recorded members wrote
 *  their acceptance, for a page that shows it. */
export async function pageRoster(
	db: D1Database,
	group: GroupRow,
	members: GroupMembers,
	confirm?: (dids: string[]) => Promise<ReadonlyMap<string, boolean> | null>
): Promise<{ entries: RosterEntry[]; source: 'records' | 'cache' }> {
	if (!hasMemberRecords(members)) {
		return { entries: rosterFromRows(await listMembers(db, group.id)), source: 'cache' };
	}
	const subjects = members.memberships.map((record) => record.subject);
	const confirmed = confirm ? await confirm(subjects) : null;
	return { entries: rosterFromRecords(members, confirmed), source: 'records' };
}

/** The canonical path: always the DID, never a handle. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

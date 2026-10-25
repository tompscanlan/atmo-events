// The one way into a group route, for the pages and every remote, since a form with a
// lookup of its own could reveal a private group. Every refusal is the same 404, except
// a 503 when the host cannot say whether the group is private, and, where a page asks,
// a notice for someone the row lists whose sign-in cannot read the group (`signInOnly`).
// Everything is read with the caller's own access.
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility, RosterEntry } from '../types';
import { credentialSpaceReader, readGroupProfile, type GroupSpaceReader } from './about-read';
import type { CallerSession } from './caller';
import { publiclyDeclared } from './declaration-writer';
import { holdsMetaRead, readsMembersSpace } from './member-grants';
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

/** Byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

export const GROUP_VISIBILITY_UNCHECKED = 'Group visibility could not be checked';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
	/** Null when the caller is on the roster, since the gate then does not ask. */
	visibility: GroupVisibility | null;
	/** Null for a signed-out visitor or a sign-in that reads no spaces. */
	reader: GroupSpaceReader | null;
	/** Hidden from the caller, but the row lists them and only their own sign-in stands
	 *  in the way. Nothing of the group was read for them. */
	signInOnly?: true;
}

export interface GroupRouteOptions {
	signInNotice?: boolean;
}

export function callerReader(caller: CallerSession | null): GroupSpaceReader | null {
	return caller && holdsMetaRead(caller.scope) ? credentialSpaceReader(caller) : null;
}

/** `signIn` is set when the row lists the caller, they are off the roster, and their
 *  sign-in cannot read the members space, so the refusal was their own PDS's. */
export function withSignIn(
	membership: CallerMembership,
	group: GroupRow,
	caller: CallerSession | null
): CallerMembership {
	if (!caller || membership.onRoster || membership.role === null || membership.unreadable) {
		return membership;
	}
	if (!group.members_space_uri || readsMembersSpace(caller.scope, group.group_did)) {
		return membership;
	}
	return { ...membership, signIn: true };
}

/** `actorToDid` cannot tell an unknown handle from an outage, so an outage is a 404 too. */
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
	caller: CallerSession | null,
	{ signInNotice = false }: GroupRouteOptions = {}
): Promise<GroupRouteContext> {
	const did = await groupActorToDid(actor);
	if (!did) error(404, GROUP_NOT_FOUND);

	const group = await getGroupByDid(db, did);
	if (!group) error(404, GROUP_NOT_FOUND);

	const reader = callerReader(caller);

	// A member sees the group at every visibility, so a failed visibility read cannot
	// lock them out.
	const membership = withSignIn(
		await readStanding(db, group, caller?.did ?? null, reader),
		group,
		caller
	);
	if (membership.onRoster) return { group, membership, visibility: null, reader };

	const hidden = (): GroupRouteContext => {
		if (signInNotice && membership.signIn) {
			return { group, membership, visibility: null, reader: null, signInOnly: true };
		}
		error(404, GROUP_NOT_FOUND);
	};

	// No space can be read for this caller, so "public" is the declaration. An unlisted
	// public group is hidden from them until its meta space can be read publicly.
	if (!reader) {
		let declared: boolean;
		try {
			declared = await publiclyDeclared(db, group.group_did);
		} catch (e) {
			console.error(`[groups] ${group.group_did}: the declaration could not be read:`, e);
			error(503, GROUP_VISIBILITY_UNCHECKED);
		}
		if (!declared) return hidden();
		return { group, membership, visibility: 'public', reader };
	}

	let visibility: GroupVisibility;
	try {
		visibility = await readGroupVisibility(reader, group);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return hidden();
		console.error(
			`[groups] ${group.group_did}: the meta space's access record could not be read:`,
			e
		);
		error(503, GROUP_VISIBILITY_UNCHECKED);
	}
	if (!canSeeGroup(visibility, membership)) return hidden();

	return { group, membership, visibility, reader };
}

/** The profile's name, else the row's, so a profile that cannot be read never fails the page. */
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

/** The records, or the rows when the members space holds none. */
export async function pageRoster(
	db: D1Database,
	group: GroupRow,
	members: GroupMembers
): Promise<RosterEntry[]> {
	return hasMemberRecords(members)
		? rosterFromRecords(members)
		: rosterFromRows(await listMembers(db, group.id));
}

/** Always the DID, never a handle. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

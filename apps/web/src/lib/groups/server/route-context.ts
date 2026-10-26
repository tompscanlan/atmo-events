// The one way into a group route, for the pages and every remote, since a lookup of its
// own could reveal a private group. Every refusal is the same 404, except a 503 when the
// host cannot say whether the group is private.
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility, RosterEntry } from '../types';
import { credentialSpaceReader, readGroupProfile, type GroupSpaceReader } from './about-read';
import { writeAcceptance } from './acceptance';
import type { CallerSession } from './caller';
import { publiclyDeclared } from './declaration-writer';
import { errorText } from './errors';
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
import { credentialAcceptanceReader, isSpaceAccessDenied } from './space-credential';

/** Byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

export const GROUP_VISIBILITY_UNCHECKED = 'Group visibility could not be checked';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
	visibility: GroupVisibility | null;
	reader: GroupSpaceReader | null;
	/** Hidden, but the row lists the caller and only their sign-in stands in the way. */
	signInOnly?: true;
}

export interface GroupRouteOptions {
	signInNotice?: boolean;
}

export function callerReader(caller: CallerSession | null): GroupSpaceReader | null {
	return caller && holdsMetaRead(caller.scope) ? credentialSpaceReader(caller) : null;
}

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

	// A create that stopped before its spaces were recorded is not a group yet.
	if (!group.about_space_uri) return hidden();
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

/** Each listed member's acceptance, read with the viewer's own credential; null when none
 *  could be had. */
async function readAcceptances(
	viewer: CallerSession,
	group: GroupRow,
	dids: string[]
): Promise<Map<string, boolean> | null> {
	if (!group.members_space_uri || dids.length === 0) return null;
	if (!readsMembersSpace(viewer.scope, group.group_did)) return null;
	try {
		return await credentialAcceptanceReader(viewer).accepted(group.members_space_uri, dids);
	} catch (e) {
		console.warn(`[groups] ${group.group_did}: acceptances could not be read:`, errorText(e));
		return null;
	}
}

/** With a viewer, each entry says whether the member confirmed, and a viewer who has not
 *  gets their acceptance written now when their session can write it (FR-205). */
export async function pageRoster(
	db: D1Database,
	group: GroupRow,
	members: GroupMembers,
	viewer: CallerSession | null = null
): Promise<RosterEntry[]> {
	if (!hasMemberRecords(members)) return rosterFromRows(await listMembers(db, group.id));
	const dids = members.memberships.map((record) => record.subject);
	const acceptances = viewer ? await readAcceptances(viewer, group, dids) : null;
	if (viewer && acceptances?.get(viewer.did) === false) {
		const wrote = await writeAcceptance(viewer, group).catch((e) => {
			console.warn(`[groups] ${viewer.did}'s acceptance in ${group.group_did}:`, errorText(e));
			return 'skipped' as const;
		});
		if (wrote !== 'skipped') acceptances.set(viewer.did, true);
	}
	return rosterFromRecords(members, acceptances);
}

/** Always the DID, never a handle. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

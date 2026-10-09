// The one way into a group route. The pages and every group remote (../remote-context.ts)
// gate a group here, since a form with its own lookup could reveal a private
// group. Every refusal is the same 404, so a hidden group looks like one that
// never existed. The exception is a 503 when the host cannot say whether the
// group is private, since a 404 would hide a public group from its visitors.
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility, RosterEntry } from '../types';
import { groupSpaceReader, readGroupProfile, type GroupSpaceReader } from './about-read';
import { knownHandles } from './identities';

import {
	hasMemberRecords,
	rosterFromRecords,
	rosterFromRows,
	type GroupMembers
} from './members-read';
import { readGroupVisibility } from './spaces';

import { type CredentialStoreEnv } from './session';
import { getGroupByDid } from './db/groups';
import { listMembers } from './db/roster';
import { readStanding } from './standing';
/** Every refusal says this, byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

export const GROUP_VISIBILITY_UNCHECKED = 'Group visibility could not be checked';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
	/** As the host reported it, so a form need not ask again. `null` when the
	 *  caller is on the roster, since the gate then does not ask. */
	visibility: GroupVisibility | null;
	/** The group's space reader, built once for the gate, or null when its owner
	 *  has not linked the group. Pages and forms read through it rather than
	 *  building another. */
	reader: GroupSpaceReader | null;
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
	env: CredentialStoreEnv,
	db: D1Database,
	actor: string,
	callerDid: string | null
): Promise<GroupRouteContext> {
	const did = await groupActorToDid(actor);
	if (!did) error(404, GROUP_NOT_FOUND);

	const group = await getGroupByDid(db, did);
	if (!group) error(404, GROUP_NOT_FOUND);

	const reader = await groupSpaceReader(env, group);

	// A caller on the roster sees the group at every visibility, so the host is
	// not asked, and a failed visibility read cannot lock a member out.
	const membership = await readStanding(db, group, callerDid, reader);
	if (membership.onRoster) return { group, membership, visibility: null, reader };

	// Without a credential the host cannot be asked, so nobody else is let in.
	if (!reader) error(404, GROUP_NOT_FOUND);

	let visibility: GroupVisibility;
	try {
		visibility = await readGroupVisibility(reader, group);
	} catch (e) {
		console.error(`[groups] ${group.group_did}: the about space's read policy did not answer:`, e);
		error(503, GROUP_VISIBILITY_UNCHECKED);
	}
	if (!canSeeGroup(visibility, membership)) error(404, GROUP_NOT_FOUND);

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

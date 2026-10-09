// The one way into a group route. The pages and every form in `groups.remote.ts`
// gate a group here, since a form with its own lookup could reveal a private
// group. Every refusal is the same 404, so a hidden group looks like one that
// never existed. The exception is a 503 when the host cannot say whether the
// group is private, since a 404 would hide a public group from its visitors.
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';

import { getCallerMembership, getGroupByDid } from './repo';
import { readGroupVisibility } from './spaces';

import { errorText } from './errors';
import { type CredentialStoreEnv } from './session';
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

/** When the members space errors, the caller is off the roster and holds no
 *  permission. The row cannot stand in: after a removal whose row delete failed,
 *  it would let the removed member in. It still supplies what the page shows,
 *  and `unreadable` makes a form say "could not be checked". When there is no
 *  reader because the owner has not linked the group, `unlinked` makes a form
 *  say that instead. */
export async function readStanding(
	db: D1Database,
	group: GroupRow,
	callerDid: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	try {
		const membership = await getCallerMembership(db, group, callerDid, reader);
		return !reader && group.members_space_uri ? { ...membership, unlinked: true } : membership;
	} catch (e) {
		if (!reader) throw e;
		console.error(
			`[groups] ${group.group_did}: members space unreadable; the caller is off the roster for this read:`,
			e
		);
		const row = await getCallerMembership(db, group, callerDid, null);
		return {
			...row,
			permissions: new Set(),
			onRoster: false,
			unreadable: errorText(e)
		};
	}
}

/** The canonical path: always the DID, never a handle. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

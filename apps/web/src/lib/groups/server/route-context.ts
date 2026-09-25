// The one way into a group route: a DID or a full handle is resolved, looked up
// and gated once, for the three loaders and for every group form.
//
// A group URL carries the group's DID. A handle is also accepted, because
// people type or paste them, but it is resolved to the DID before any lookup,
// and it is never what we publish.
//
// ONE FUNCTION, NOT A CONVENTION. The pages and `groups.remote.ts` both go
// through here, so a form cannot disagree with the page it was posted from. A
// remote `form()` is an addressable POST bound to nothing but sign-in and the
// group key, so a form with its own lookup could reveal whether a private group
// exists. Every refusal below is the same 404 with the same message, which
// makes an invisible group look exactly like one that never existed.
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import type { CredentialStoreEnv } from './credentials';
import { getCallerMembership, getGroupByDid } from './repo';

/** Every refusal says this, byte for byte. An unknown DID, a handle that does
 *  not resolve, a DID this deployment holds no group for, and a private group
 *  the caller may not see are one answer on purpose. */
export const GROUP_NOT_FOUND = 'Group not found';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
}

/** A route key to a DID, or null when it cannot be one.
 *
 *  A `did:` prefix is taken as is: it costs nothing to look up, and a DID we
 *  hold no group for gets the same 404 as a bad one. Anything else is a handle
 *  and goes to the resolver (DoH + `.well-known`, cached per isolate for an
 *  hour, three attempts).
 *
 *  KNOWN LIMIT. `actorToDid` throws the same way for "this handle has no DID"
 *  and "the resolver was unreachable", so a resolver outage answers 404 for a
 *  handle URL instead of an error. This layer cannot tell the two apart, and
 *  an unresolvable handle must be a 404. It only affects a hand-typed handle:
 *  every URL the app publishes carries the DID and never reaches the
 *  resolver. */
export async function groupActorToDid(actor: string): Promise<string | null> {
	if (actor.startsWith('did:')) return actor;
	try {
		return await actorToDid(actor);
	} catch {
		return null;
	}
}

/** Resolve → look up → gate. Throws the 404 above at each step; returns the
 *  group and the caller's standing in it, which every caller needs next. */
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

	// The membership lookup comes first because whether the caller may see the
	// group is a question about their membership record. An anonymous caller has
	// no standing to resolve, so no credential is unsealed for them.
	const reader = callerDid ? await groupSpaceReader(env, db, group) : null;
	const membership = await readStanding(db, group, callerDid, reader);
	if (!canSeeGroup(group, membership)) error(404, GROUP_NOT_FOUND);

	return { group, membership };
}

/** The caller's standing for a read. When the members space errors, this
 *  answers from the roster row instead of failing the page. That is softer
 *  than the write gate on purpose, so a PDS blip does not 404 a member out of
 *  their own private group. The fallback grants no permission: without the
 *  records the loader returns none, so no management control renders. It is
 *  marked `unreadable`, so a form refuses with "could not be checked" rather
 *  than "not allowed". */
export async function readStanding(
	db: D1Database,
	group: GroupRow,
	callerDid: string | null,
	reader: GroupSpaceReader | null
): Promise<CallerMembership> {
	try {
		return await getCallerMembership(db, group, callerDid, reader);
	} catch (e) {
		if (!reader) throw e;
		console.error(
			`[groups] ${group.group_did}: members space unreadable; the roster row answers this read:`,
			e
		);
		const fallback = await getCallerMembership(db, group, callerDid, null);
		return { ...fallback, unreadable: e instanceof Error ? e.message : String(e) };
	}
}

/** The canonical path for a group: the DID, always. Every link and redirect
 *  uses it, so a handle URL is never passed on. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

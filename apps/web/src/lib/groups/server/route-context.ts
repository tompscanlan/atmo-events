// THE ONE WAY INTO A GROUP ROUTE: a DID or a full handle, resolved, looked up,
// and gated — once, for the three loaders and for every group form.
//
// A group URL carries the group's DID. It used to carry a slug, which was a
// second name for the same thing and a second thing to keep unique; the mint's
// handle registration already adjudicates the name, so the slug was deleted
// rather than demoted to an alias (FR-001a, FR-010a). A handle is still ACCEPTED
// — someone types or pastes one — but it is resolved to the DID before any
// lookup, and it is never what we publish.
//
// ONE FUNCTION, NOT A CONVENTION. The pages and `groups.remote.ts` both go
// through here so a form cannot disagree with the page it was posted from: a
// remote `form()` is an addressable POST bound to nothing but sign-in and the
// group key, so a form with its own lookup was a private group's existence
// oracle (om-5oxc8). Every refusal below is the SAME 404 with the same message,
// which is what makes an invisible group indistinguishable from one that never
// existed (FR-016a, SC-009).
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow } from '../types';
import { groupSpaceReader } from './about-read';
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
 *  A `did:` prefix is taken as-is: it costs nothing to look up and a DID we
 *  hold no group for is the same 404 as a bad one. Anything else is a handle
 *  and goes to the resolver (DoH + `.well-known`, cached per isolate for an
 *  hour, three attempts).
 *
 *  KNOWN CONFLATION, stated rather than hidden: `actorToDid` throws the same way
 *  for "this handle has no DID" and "the resolver was unreachable", so a
 *  resolver outage answers 404 for a handle URL instead of an error. It cannot
 *  be told apart at this layer, and the spec requires the unresolvable case to
 *  404 (FR-010a). It only ever affects a hand-typed handle: every URL the app
 *  publishes carries the DID and never reaches the resolver. */
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

	// The membership lookup comes first because whether the caller may SEE the
	// group is a question about their roster row. An anonymous caller has no
	// permissions to resolve, so no credential is unsealed for them.
	const reader = callerDid ? await groupSpaceReader(env, db, group) : null;
	const membership = await getCallerMembership(db, group, callerDid, reader);
	if (!canSeeGroup(group, membership)) error(404, GROUP_NOT_FOUND);

	return { group, membership };
}

/** The canonical path for a group: the DID, always. Used by every link and
 *  redirect so a handle URL is never propagated (FR-010a). */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

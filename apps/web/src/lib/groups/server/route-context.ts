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
//
// ONE EXCEPTION: A HOST THAT DOES NOT ANSWER. Whether a group is private is its
// about space's read policy, which only its host can report. When that read
// fails for a caller off the roster, the route answers 503 "visibility could
// not be checked" instead of guessing. A 404 there would tell the visitors of
// a public group that it does not exist. What the 503 gives away is that this
// deployment hosts a group at the DID, and the DID is already public in the
// PLC log (../access.ts).
import { error } from '@sveltejs/kit';
import { actorToDid } from '$lib/atproto/methods';
import { canSeeGroup } from '../access';
import type { CallerMembership, GroupRow, GroupVisibility } from '../types';
import { groupSpaceReader, type GroupSpaceReader } from './about-read';
import type { CredentialStoreEnv } from './credentials';
import { getCallerMembership, getGroupByDid } from './repo';
import { readGroupVisibility } from './spaces';

/** Every refusal says this, byte for byte. An unknown DID, a handle that does
 *  not resolve, a DID this deployment holds no group for, and a private group
 *  the caller may not see are one answer on purpose. */
export const GROUP_NOT_FOUND = 'Group not found';

/** The one other answer, with a 503: the host did not say whether the group is
 *  private, so the caller is neither admitted nor told it does not exist. */
export const GROUP_VISIBILITY_UNCHECKED = 'Group visibility could not be checked';

export interface GroupRouteContext {
	group: GroupRow;
	membership: CallerMembership;
	/** The group's visibility as its host reported it, so a form can use the
	 *  answer the gate already read instead of asking again. `null` when the
	 *  caller is on the roster: every visibility admits them, so the host was
	 *  not asked. */
	visibility: GroupVisibility | null;
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

/** Resolve → look up → gate. Throws the 404 above at each step, and the 503
 *  when the host cannot say whether a caller off the roster may see the group.
 *  Returns the group, the caller's standing in it and the visibility the gate
 *  read, which every caller needs next. */
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

	// The reader is built for every caller, anonymous ones included, because it
	// is also how the gate asks the host about the group's visibility.
	const reader = await groupSpaceReader(env, db, group);

	// The membership half first. Whether the caller is on the roster is a
	// question about their membership record, and a caller on it sees the group
	// at every visibility, so the host is not asked about visibility: one read
	// fewer, and a visibility read that fails cannot lock out a member whose
	// standing was read. A members space that cannot be read confirms nobody,
	// so the caller then goes through the visibility check like anyone else.
	const membership = await readStanding(db, group, callerDid, reader);
	if (membership.onRoster) return { group, membership, visibility: null };

	// A deployment that holds no credential for the group cannot ask its host,
	// and without the host's answer nobody off the roster is admitted.
	if (!reader) error(404, GROUP_NOT_FOUND);

	let visibility: GroupVisibility;
	try {
		visibility = await readGroupVisibility(reader, group);
	} catch (e) {
		console.error(`[groups] ${group.group_did}: the about space's read policy did not answer:`, e);
		error(503, GROUP_VISIBILITY_UNCHECKED);
	}
	if (!canSeeGroup(visibility, membership)) error(404, GROUP_NOT_FOUND);

	return { group, membership, visibility };
}

/** The caller's standing for a read. When the members space errors, the caller
 *  is off the roster for this read and holds no permission, and the gate then
 *  decides as it would for a stranger: a public group reads as it does for
 *  anyone, a private one is a 404, and one whose host cannot say which is a
 *  503. The row cannot stand in for the record: a removal whose row delete
 *  failed leaves a row and no record, and answering from the row would let the
 *  member it removed read a private group whenever the members space is down
 *  and the about space is not. Members lose what only members see for as long
 *  as that lasts.
 *
 *  The row still supplies `role`, `status` and `pendingRequestId`, which the
 *  page shows and nothing gates on. The standing is marked `unreadable`, so a
 *  form refuses with "could not be checked" rather than "not allowed". */
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
			`[groups] ${group.group_did}: members space unreadable; the caller is off the roster for this read:`,
			e
		);
		const row = await getCallerMembership(db, group, callerDid, null);
		return {
			...row,
			permissions: new Set(),
			onRoster: false,
			unreadable: e instanceof Error ? e.message : String(e)
		};
	}
}

/** The canonical path for a group: the DID, always. Every link and redirect
 *  uses it, so a handle URL is never passed on. */
export function groupPath(group: Pick<GroupRow, 'group_did'>, sub?: 'events' | 'members'): string {
	return sub ? `/groups/${group.group_did}/${sub}` : `/groups/${group.group_did}`;
}

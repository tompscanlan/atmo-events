// The OAuth grant that lets a member write their own records into a group's
// spaces (their acceptance, and their RSVPs to members-only events), how sign-in
// asks for it, and what the client metadata declares.
//
// The grant names the group as authority, so consent shows no "every space on
// the network" warning, and only those two collections, so it cannot touch
// anything else in the group's spaces. It says `space:*` rather than a space
// type, because the PDS resolves every type a scope names and the
// group.opensocial lexicons do not resolve yet, so a typed scope fails consent.
// Like any `space:*` grant, it covers every space of the group. (Spec: FR-208.)
//
// It carries `read_self` so the member's own session can read their RSVP back
// for the event page: a grant with only create, update and delete cannot read
// its own record. (Spec: FR-113.)
//
// A PDS refuses any requested scope that is not written verbatim in the client
// metadata, so the metadata declares one grant per group this deployment holds.
// It caches that metadata for 10 minutes, so a group younger than that may be
// missing from the copy a PDS holds: sign-in then retries without those grants,
// and asks for them again at the next sign-in.
import { OAuthResponseError } from '@atcute/oauth-node-client';
import { GROUP_RSVP_COLLECTION } from '../ids';
import { GROUP_ACCEPTANCE_COLLECTION } from '../members-record';

import { groupsOfMember } from './repo';
/** How long a PDS may keep serving client metadata it fetched earlier. */
export const METADATA_CACHE_MS = 10 * 60 * 1000;

/** The scope a member needs in `groupDid`'s spaces: to create, update and
 *  delete their acceptance, and to write, delete and read back their own RSVP
 *  to a members-only event there, and nothing else. One token per group, so a
 *  session never holds half of it. */
export function memberGrant(groupDid: string): string {
	return `space:*?authority=${groupDid}&collection=${GROUP_ACCEPTANCE_COLLECTION}&collection=${GROUP_RSVP_COLLECTION}&action=read_self&action=create&action=update&action=delete`;
}

/** Whether a granted scope lets its holder `action` their acceptance in
 *  `groupDid`'s spaces. Read by parameter, not compared as a string, so a PDS
 *  that reorders the grant's parameters still counts. A stock PDS drops a space
 *  grant it does not know, so a missing grant also means the member's PDS serves
 *  no spaces. */
export function holdsAcceptanceGrant(
	scope: string,
	groupDid: string,
	action: 'create' | 'delete'
): boolean {
	return groupSpaceGrants(scope, groupDid).some(
		(params) =>
			params.getAll('collection').includes(GROUP_ACCEPTANCE_COLLECTION) &&
			params.getAll('action').includes(action)
	);
}

/** The parameters of each `space:*` grant in `scope` whose authority is
 *  `groupDid`. */
function groupSpaceGrants(scope: string, groupDid: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith('space:*?'))
		.map((token) => new URLSearchParams(token.slice('space:*?'.length)))
		.filter((params) => params.get('authority') === groupDid);
}

/** Whether a granted scope lets its holder put, delete or read back their own
 *  RSVP in `groupDid`'s spaces. Read by parameter, like `holdsAcceptanceGrant`,
 *  and by the PDS's rule: a write needs its action and the RSVP collection in
 *  one grant, and a put asks for create when the record is new and update when
 *  it is not, so it needs both; a read of one's own record needs read_self or
 *  read and ignores the collection. A grant from before RSVPs joined it holds
 *  none of the three, and neither does the scope a PDS without spaces leaves. */
export function holdsRsvpGrant(
	scope: string,
	groupDid: string,
	need: 'put' | 'delete' | 'read'
): boolean {
	const grants = groupSpaceGrants(scope, groupDid);
	if (need === 'read') {
		return grants.some((params) =>
			params.getAll('action').some((action) => action === 'read_self' || action === 'read')
		);
	}
	const writes = (action: string) =>
		grants.some(
			(params) =>
				params.getAll('collection').includes(GROUP_RSVP_COLLECTION) &&
				params.getAll('action').includes(action)
		);
	return need === 'put' ? writes('create') && writes('update') : writes('delete');
}

/** One grant per group in D1, for the client metadata. A failed read declares
 *  none: the metadata still serves the base scopes, and sign-in falls back to
 *  them. It does not create the groups tables, because a deployment that never
 *  used groups should not get them from its metadata route. */
export async function declaredGrants(db: D1Database): Promise<string[]> {
	try {
		const { results } = await db
			.prepare(`SELECT group_did FROM groups ORDER BY created_at, group_did`)
			.all<{ group_did: string }>();
		return results.map((r) => memberGrant(r.group_did));
	} catch (e) {
		console.warn('[groups] client metadata declares no group grants:', e);
		return [];
	}
}

/** The grant sets a sign-in by `did` tries, most first. The first asks for
 *  every group `did` has joined or has a pending request in. If any of those
 *  groups is younger than the metadata cache, the next drops them. The last
 *  asks for none, so a PDS that refuses the grants for any other reason still
 *  lets the member sign in. A user in no group gets the one empty set, and so
 *  exactly the base scope. A failed read is treated as no groups, because the
 *  groups lookup must never be what stops a sign-in. */
export async function signInGrantAttempts(
	db: D1Database,
	did: string,
	now: number
): Promise<string[][]> {
	let groups: { group_did: string; created_at: number }[];
	try {
		groups = await groupsOfMember(db, did);
	} catch (e) {
		console.warn('[groups] sign-in asks for no group grants:', e);
		groups = [];
	}
	if (groups.length === 0) return [[]];

	const all = groups.map((g) => memberGrant(g.group_did));
	const settled = groups
		.filter((g) => now - g.created_at >= METADATA_CACHE_MS)
		.map((g) => memberGrant(g.group_did));

	const attempts = [all];
	if (settled.length < all.length && settled.length > 0) attempts.push(settled);
	attempts.push([]);
	return attempts;
}

/** Runs `authorize` with each grant set in turn until the PDS accepts one. Only
 *  an `invalid_scope` refusal moves on to the next set; any other error, or a
 *  refusal of the last set, is thrown as it came. Each retry is logged: a member
 *  whose grant keeps being refused stays unconfirmed, and nothing else says why. */
export async function firstAcceptedScope<T>(
	attempts: readonly (readonly string[])[],
	authorize: (grants: string[]) => Promise<T>
): Promise<T> {
	let refusal: unknown;
	for (const [i, grants] of attempts.entries()) {
		try {
			return await authorize([...grants]);
		} catch (e) {
			if (!(e instanceof OAuthResponseError && e.error === 'invalid_scope')) throw e;
			refusal = e;
			const next = attempts[i + 1];
			if (next) {
				console.warn(
					`[groups] PDS refused ${grants.length} group grants, retrying with ${next.length}: ${e.errorDescription ?? e.error}`
				);
			}
		}
	}
	throw refusal;
}

/** Runs `authorize` once more after `did` joins or asks to join `groupDid`, so
 *  the member's session carries that group's grant before the next sign-in. It
 *  asks for every grant sign-in would, since the new session replaces the old
 *  one, and only tries the sets that include the new group's grant: a set
 *  without it would reissue what the member already holds. Returns null when
 *  the PDS refuses each such set or anything else fails, and never throws,
 *  because the join already stands and the grant then comes at the next sign-in. */
export async function reauthorizeForGroup<T>(
	db: D1Database,
	did: string,
	groupDid: string,
	now: number,
	authorize: (grants: string[]) => Promise<T>
): Promise<T | null> {
	const grant = memberGrant(groupDid);
	try {
		const attempts = (await signInGrantAttempts(db, did, now)).filter((a) => a.includes(grant));
		if (attempts.length === 0) return null;
		return await firstAcceptedScope(attempts, authorize);
	} catch (e) {
		console.warn(
			`[groups] no re-authorize after joining ${groupDid}; the grant waits for the next sign-in:`,
			e
		);
		return null;
	}
}

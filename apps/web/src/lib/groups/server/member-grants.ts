// The OAuth grant that lets a member write their own acceptance into a group's
// space, how sign-in asks for it, and what the client metadata declares.
//
// The grant names the group as authority, so consent shows no "every space on
// the network" warning, and only the acceptance collection, so it cannot touch
// anything else in the group's spaces. It says `space:*` rather than the members
// space type, because the PDS resolves every type a scope names and the
// group.opensocial lexicons do not resolve yet, so a typed scope fails consent.
// (Spec: FR-208.)
//
// A PDS refuses any requested scope that is not written verbatim in the client
// metadata, so the metadata declares one grant per group this deployment holds.
// It caches that metadata for 10 minutes, so a group younger than that may be
// missing from the copy a PDS holds: sign-in then retries without those grants,
// and asks for them again at the next sign-in.
import { OAuthResponseError } from '@atcute/oauth-node-client';

const ACCEPTANCE_COLLECTION = 'group.opensocial.acceptance';

/** How long a PDS may keep serving client metadata it fetched earlier. */
export const METADATA_CACHE_MS = 10 * 60 * 1000;

/** The scope a member needs to create, update and delete their acceptance in
 *  `groupDid`'s spaces, and nothing else there. */
export function acceptanceGrant(groupDid: string): string {
	return `space:*?authority=${groupDid}&collection=${ACCEPTANCE_COLLECTION}&action=create&action=update&action=delete`;
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
		return results.map((r) => acceptanceGrant(r.group_did));
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
		const { results } = await db
			.prepare(
				`SELECT g.group_did, g.created_at FROM groups g
				 WHERE g.id IN (
				   SELECT group_id FROM memberships WHERE did = ?
				   UNION
				   SELECT group_id FROM join_requests WHERE did = ? AND status = 'pending'
				 )
				 ORDER BY g.created_at, g.group_did`
			)
			.bind(did, did)
			.all<{ group_did: string; created_at: number }>();
		groups = results;
	} catch (e) {
		console.warn('[groups] sign-in asks for no group grants:', e);
		groups = [];
	}
	if (groups.length === 0) return [[]];

	const all = groups.map((g) => acceptanceGrant(g.group_did));
	const settled = groups
		.filter((g) => now - g.created_at >= METADATA_CACHE_MS)
		.map((g) => acceptanceGrant(g.group_did));

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
	const grant = acceptanceGrant(groupDid);
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

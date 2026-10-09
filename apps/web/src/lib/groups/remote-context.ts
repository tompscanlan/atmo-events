// What every group remote resolves before it acts, and the caller's session as
// the remotes need it. A plain module, so it can be tested and shared: a
// `*.remote.ts` may export only remote functions.
//
// Every handler resolves the group by DID, resolves the caller's membership,
// asks `can()`, then acts. `locals.did` is only the subject of that check:
// group events are authored by the group's own DID (./server/event-writer.ts).
import { error } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import type { Did } from '@atcute/lexicons';
import { servesClientMetadata } from '$lib/atproto/server/oauth';
import type { CallerMembership, GroupRow, GroupVisibility } from './types';
import type { GroupSpaceReader } from './server/about-read';
import { memberSession, type MemberSession } from './server/acceptance';
import { reauthorizeForGroup } from './server/member-grants';
import { groupRouteContext } from './server/route-context';
import { authorizeWithGrants } from './server/sign-in-grants';

/** What every handler resolves before it acts: the bindings, the group, and the
 *  caller's standing in it. */
export interface GroupRequestContext {
	db: D1Database;
	env: App.Platform['env'];
	group: GroupRow;
	membership: CallerMembership;
	/** The host's visibility, when the gate asked. The join refusal reads it. */
	visibility: GroupVisibility | null;
	/** The gate's reader, so an act reads through the same session. */
	reader: GroupSpaceReader | null;
	/** Never null: `groupRequestContext` throws 401 before returning. */
	callerDid: string;
}

/** Throws 401 when not signed in, and the route's own 404 for every other
 *  refusal. It uses the pages' lookup (`server/route-context.ts`): anyone
 *  signed in can POST a remote form with any group key, so a separate lookup
 *  could reveal that a private group exists. */
export async function groupRequestContext(actor: string): Promise<GroupRequestContext> {
	const { locals, platform } = getRequestEvent();
	if (!locals.did) error(401, 'Sign in to do that');
	const db = platform!.env.DB;
	const { group, membership, visibility, reader } = await groupRouteContext(
		platform!.env,
		db,
		actor,
		locals.did
	);
	return { db, env: platform!.env, group, membership, visibility, reader, callerDid: locals.did };
}

/** The caller's own session, for their acceptance (./server/acceptance.ts). Null
 *  when there is none to read, and then no acceptance is touched. */
export async function callerMember(): Promise<MemberSession | null> {
	const { locals } = getRequestEvent();
	if (!locals.session) return null;
	try {
		return await memberSession(locals.session);
	} catch (e) {
		console.warn('[groups] no member session for the acceptance:', e);
		return null;
	}
}

/** Where to send a member who just joined or asked to join, so their session
 *  carries the group's acceptance grant before their next sign-in, since joining
 *  or requesting re-authorizes, or a member whose session lacks the grant when
 *  they RSVP to a members-only event. (Spec: FR-208.) On a device the PDS remembers,
 *  nothing shows unless the request holds a grant not approved before. Otherwise
 *  the PDS asks for the password and consent again, listing every scope. Null
 *  when there is no client metadata to grow, or the PDS refused. */
export async function reauthorizeUrl(ctx: GroupRequestContext): Promise<string | null> {
	if (!servesClientMetadata(ctx.env)) return null;
	const result = await reauthorizeForGroup(
		ctx.db,
		ctx.callerDid,
		ctx.group.group_did,
		Date.now(),
		(grants) =>
			authorizeWithGrants(ctx.env, grants, {
				target: { type: 'account', identifier: ctx.callerDid as Did }
			})
	);
	return result?.url.toString() ?? null;
}

/** A stamp of the caller's session: when its token expires, in milliseconds,
 *  read without a refresh, or 0 when there is no session or it can't be read.
 *  A new sign-in issues a new token, which is how an asked marker tells a
 *  member back from consent from one who never left. */
export async function sessionStamp(): Promise<number> {
	const { locals } = getRequestEvent();
	if (!locals.session) return 0;
	try {
		const { expiresAt } = await locals.session.getTokenInfo(false);
		return expiresAt?.getTime() ?? 0;
	} catch {
		return 0;
	}
}

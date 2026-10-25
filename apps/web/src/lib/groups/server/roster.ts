// What a roster act at the group host (./real-host.ts) leaves to the caller's
// own session: their acceptance (./acceptance.ts). A joined member writes theirs
// after the host admits them, and a leaving one deletes theirs before the host
// drops them, so the host still accepts the notice of the delete. Neither stops
// the act: the acceptance decides how the roster shows a member, not what they
// may do.
import type { GroupRow } from '../types';

import type { GroupSpaceReader } from './about-read';
import { deleteAcceptance, writeAcceptance, type MemberSession } from './acceptance';
import type { CredentialStoreEnv } from './session';

/** What a roster act needs. A handler's own context satisfies it. */
export interface RosterContext {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string;
	/** The caller's own reader, for the permission gates: an admin's read before
	 *  a write uses their own access. */
	reader?: GroupSpaceReader | null;
	/** The caller's own session at their PDS, for their acceptance. Absent, or
	 *  someone else's, and no acceptance is touched. */
	member?: MemberSession | null;
}

/** The session, when it is the caller's own. */
function callerSession(ctx: RosterContext): MemberSession | null {
	return ctx.member && ctx.member.did === ctx.callerDid ? ctx.member : null;
}

/** The caller writes their acceptance. A failure is logged, and a sign-in that
 *  holds the grant writes it later. */
export async function accept(ctx: RosterContext): Promise<void> {
	const member = callerSession(ctx);
	if (!member) return;
	try {
		await writeAcceptance(member, ctx.group);
	} catch (e) {
		console.warn(`[groups] ${member.did} wrote no acceptance in ${ctx.group.group_did}:`, e);
	}
}

/** The caller deletes their acceptance. A failure is logged and the act goes on:
 *  an acceptance with no membership never reaches the roster. */
export async function unaccept(ctx: RosterContext): Promise<void> {
	const member = callerSession(ctx);
	if (!member) return;
	try {
		await deleteAcceptance(member, ctx.group);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s acceptance in ${ctx.group.group_did} stays:`, e);
	}
}

// The member's own half of a membership: their `acceptance`, in their repo in the group's
// members space, written with their own session. It decides whether the roster lists them,
// never what they may do. Written at an open join, at sign-in and on a member's next visit,
// never for a pending request; deleted when they leave.
import type { OAuthSession } from '@atcute/oauth-node-client';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY } from '../members-record';
import type { GroupRow } from '../types';
import { callerSession, type CallerSession } from './caller';
import { groupsOfMember } from './db/roster';
import { errorText } from './errors';
import { holdsAcceptanceGrant } from './member-grants';
import { xrpc, xrpcError } from './xrpc';

type AcceptanceGroup = Pick<GroupRow, 'group_did' | 'members_space_uri'>;

/** A create, so an existing acceptance keeps its date and no read is needed. `skipped` when
 *  the group has no members space or the session lacks the grant (a PDS with no spaces). */
export async function writeAcceptance(
	member: CallerSession,
	group: AcceptanceGroup,
	now: Date = new Date()
): Promise<'written' | 'present' | 'skipped'> {
	const space = group.members_space_uri;
	if (!space || !holdsAcceptanceGrant(member.scope, group.group_did, 'create')) return 'skipped';
	const nsid = 'com.atproto.space.createRecord';
	const result = await xrpc(member.handle, nsid, {
		body: {
			space,
			repo: member.did,
			collection: GROUP_ACCEPTANCE_COLLECTION,
			rkey: GROUP_ACCEPTANCE_RKEY,
			record: { $type: GROUP_ACCEPTANCE_COLLECTION, createdAt: now.toISOString() }
		}
	});
	if (result.ok) return 'written';
	if (result.status === 400 && result.error === 'RecordAlreadyExists') return 'present';
	throw xrpcError(nsid, result);
}

/** The PDS answers the same whether or not it was there. */
export async function deleteAcceptance(
	member: CallerSession,
	group: AcceptanceGroup
): Promise<'deleted' | 'skipped'> {
	const space = group.members_space_uri;
	if (!space || !holdsAcceptanceGrant(member.scope, group.group_did, 'delete')) return 'skipped';
	const nsid = 'com.atproto.space.deleteRecord';
	const result = await xrpc(member.handle, nsid, {
		body: {
			space,
			repo: member.did,
			collection: GROUP_ACCEPTANCE_COLLECTION,
			rkey: GROUP_ACCEPTANCE_RKEY
		}
	});
	if (result.ok) return 'deleted';
	throw xrpcError(nsid, result);
}

/** After a join the host admitted. A failure leaves the member unconfirmed until a later
 *  sign-in or visit writes it. */
export async function accept(member: CallerSession | null | undefined, group: AcceptanceGroup) {
	if (!member) return;
	try {
		await writeAcceptance(member, group);
	} catch (e) {
		console.warn(
			`[groups] ${member.did} has no acceptance in ${group.group_did} yet:`,
			errorText(e)
		);
	}
}

/** Before a leave, while the host still counts them a member. An acceptance with no
 *  membership never reaches the roster, so a failure does not stop the leave. */
export async function unaccept(member: CallerSession | null | undefined, group: AcceptanceGroup) {
	if (!member) return;
	try {
		await deleteAcceptance(member, group);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s acceptance in ${group.group_did} stays:`, errorText(e));
	}
}

/** The sign-in callback's call: an acceptance for each group the rows list the member in.
 *  Never throws, so groups never fail a sign-in. */
export async function acceptOnSignIn(
	db: D1Database | undefined,
	session: OAuthSession
): Promise<void> {
	if (!db) return;
	const member = await callerSession(session);
	if (!member || !holdsAcceptanceGrant(member.scope, '*', 'create')) return;
	let groups: AcceptanceGroup[];
	try {
		groups = await groupsOfMember(db, member.did);
	} catch (e) {
		console.warn('[groups] sign-in writes no acceptances:', errorText(e));
		return;
	}
	await Promise.all(groups.map((group) => accept(member, group)));
}

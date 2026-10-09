// The member's own half of a membership: their `acceptance`, written from their
// own session into their repo in the group's members space. It decides whether
// the roster shows them confirmed, never what they may do. (Spec: FR-205, FR-209.)
//
// Written at an open join, at a join request, and at any sign-in where the member
// is in the group or has asked to join and has none yet: that covers the creator,
// a direct admit, and a write that could not happen at its first moment. Deleted
// at leave and when a request is withdrawn.
//
// Every write is a create. The PDS refuses a create where the record exists, with
// `RecordAlreadyExists`, so one call writes it only when it is missing, needs no
// read (and so no read grant), and leaves an existing acceptance's date alone.
// A call is made only when the member's session holds the group's grant
// (./member-grants.ts), which is also how a PDS without spaces is skipped.
import type { OAuthSession } from '@atcute/oauth-node-client';
import {
	GROUP_ACCEPTANCE_COLLECTION,
	GROUP_ACCEPTANCE_RKEY,
	groupAcceptanceRecord
} from '../members-record';
import type { GroupRow } from '../types';
import { holdsAcceptanceGrant } from './member-grants';

import { xrpc, xrpcError } from './xrpc';
/** The member's session at their own PDS, as an acceptance write needs it. */
export interface MemberSession {
	did: string;
	/** What the member's PDS granted, space-separated. */
	scope: string;
	/** A request to the member's PDS, as the member. */
	handle(pathname: string, init: RequestInit): Promise<Response>;
}

/** A signed-in member's session, read without a token refresh: the granted
 *  scope does not change on one. */
export async function memberSession(session: OAuthSession): Promise<MemberSession> {
	const { scope } = await session.getTokenInfo(false);
	return { did: session.did, scope, handle: (pathname, init) => session.handle(pathname, init) };
}

type AcceptanceGroup = Pick<GroupRow, 'group_did' | 'members_space_uri'>;

/** Writes the member's acceptance unless it exists. `skipped` when the group has
 *  no members space or the session lacks its grant. Any other refusal throws. */
export async function writeAcceptance(
	member: MemberSession,
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
			record: {
				$type: GROUP_ACCEPTANCE_COLLECTION,
				...groupAcceptanceRecord({ createdAt: now.toISOString() })
			}
		}
	});
	if (result.ok) return 'written';
	if (result.status === 400 && result.error === 'RecordAlreadyExists') return 'present';
	throw xrpcError(nsid, result);
}

/** Deletes the member's acceptance. The PDS answers the same whether or not it
 *  was there. `skipped` as for a write. Any refusal throws. */
export async function deleteAcceptance(
	member: MemberSession,
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

/** At sign-in: an acceptance for each group the member is in or has asked to
 *  join, wherever one is missing and the session holds the grant. Never throws,
 *  because the groups half must not be what fails a sign-in. A failure leaves
 *  that member unconfirmed there, and the next sign-in tries again. */
export async function writeMissingAcceptances(
	db: D1Database,
	member: MemberSession
): Promise<void> {
	let groups: AcceptanceGroup[];
	try {
		const { results } = await db
			.prepare(
				`SELECT group_did, members_space_uri FROM groups
				 WHERE members_space_uri IS NOT NULL AND id IN (
				   SELECT group_id FROM memberships WHERE did = ?
				   UNION
				   SELECT group_id FROM join_requests WHERE did = ? AND status = 'pending'
				 )`
			)
			.bind(member.did, member.did)
			.all<AcceptanceGroup>();
		groups = results;
	} catch (e) {
		console.warn('[groups] sign-in writes no acceptances:', e);
		return;
	}
	await Promise.all(
		groups.map(async (group) => {
			try {
				await writeAcceptance(member, group);
			} catch (e) {
				console.warn(`[groups] ${member.did} has no acceptance in ${group.group_did} yet:`, e);
			}
		})
	);
}

/** The sign-in callback's call. A member who holds no group grant is not asked
 *  about groups at all, so a deployment that never used groups reads nothing.
 *  Never throws. */
export async function acceptOnSignIn(
	db: D1Database | undefined,
	session: OAuthSession
): Promise<void> {
	if (!db) return;
	let member: MemberSession;
	try {
		member = await memberSession(session);
	} catch (e) {
		console.warn('[groups] sign-in writes no acceptances, the session scope is unreadable:', e);
		return;
	}
	if (!member.scope.includes(GROUP_ACCEPTANCE_COLLECTION)) return;
	await writeMissingAcceptances(db, member);
}

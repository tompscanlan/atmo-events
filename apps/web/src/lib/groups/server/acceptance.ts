// The member's own half of a membership: their `acceptance`, in their repo in the group's
// members space, written with their own session. It decides whether the roster lists them,
// never what they may do. Written at an open join and on a member's visit, never for a
// pending request; deleted when they leave.
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY, membersSpaceUri } from '../ids';
import { holdsAcceptanceGrant } from '../scopes';
import type { CallerSession } from './caller';
import { xrpc, XrpcError } from './xrpc';

/** A create, so an existing acceptance keeps its date and no read is needed. `skipped` when
 *  the session lacks the grant, as on a PDS with no spaces. */
export async function writeAcceptance(
	member: CallerSession,
	groupDid: string,
	now: Date = new Date()
): Promise<'written' | 'present' | 'skipped'> {
	if (!holdsAcceptanceGrant(member.scope, groupDid, 'create')) return 'skipped';
	try {
		await xrpc(member.handle, 'com.atproto.space.createRecord', {
			body: {
				space: membersSpaceUri(groupDid),
				repo: member.did,
				collection: GROUP_ACCEPTANCE_COLLECTION,
				rkey: GROUP_ACCEPTANCE_RKEY,
				record: { $type: GROUP_ACCEPTANCE_COLLECTION, createdAt: now.toISOString() }
			}
		});
		return 'written';
	} catch (e) {
		if (e instanceof XrpcError && e.status === 400 && e.error === 'RecordAlreadyExists') {
			return 'present';
		}
		throw e;
	}
}

/** The PDS answers the same whether or not it was there. */
export async function deleteAcceptance(
	member: CallerSession,
	groupDid: string
): Promise<'deleted' | 'skipped'> {
	if (!holdsAcceptanceGrant(member.scope, groupDid, 'delete')) return 'skipped';
	await xrpc(member.handle, 'com.atproto.space.deleteRecord', {
		body: {
			space: membersSpaceUri(groupDid),
			repo: member.did,
			collection: GROUP_ACCEPTANCE_COLLECTION,
			rkey: GROUP_ACCEPTANCE_RKEY
		}
	});
	return 'deleted';
}

/** After a join the host admitted, and on a member's visit. A failure leaves them
 *  unconfirmed until a later visit writes it. */
export async function accept(member: CallerSession, groupDid: string): Promise<boolean> {
	try {
		return (await writeAcceptance(member, groupDid)) !== 'skipped';
	} catch (e) {
		console.warn(`[groups] ${member.did} has no acceptance in ${groupDid} yet:`, e);
		return false;
	}
}

/** Before a leave, while the host still counts them a member. An acceptance with no
 *  membership never reaches the roster, so a failure does not stop the leave. */
export async function unaccept(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await deleteAcceptance(member, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s acceptance in ${groupDid} stays:`, e);
	}
}

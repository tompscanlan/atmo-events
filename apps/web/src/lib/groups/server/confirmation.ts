// The member's own half of a membership: their `org.atgrp.confirmation`, in their repo in the
// group's members space, written through their own PDS. The group writes the membership; the
// confirmation says the member agrees to it. Written on a member's visit, after the host says they
// are one, never for a request still waiting; deleted when they leave.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { GROUP_CONFIRMATION_COLLECTION, GROUP_CONFIRMATION_RKEY, membersSpaceUri } from '../ids';
import { holdsConfirmationGrant } from '../scopes';
import { errorKind, xrpc, XrpcError } from './xrpc';

/** A create, so an existing confirmation keeps its date and nothing need be read first. `skipped`
 *  when the session lacks the grant, as on a PDS without spaces. */
export async function writeConfirmation(
	member: CallerSession,
	groupDid: string,
	now: Date = new Date()
): Promise<'written' | 'present' | 'skipped'> {
	if (!holdsConfirmationGrant(member.scope, 'create', groupDid)) return 'skipped';
	try {
		await xrpc(member.handle, 'com.atproto.space.createRecord', {
			body: {
				space: membersSpaceUri(groupDid),
				repo: member.did,
				collection: GROUP_CONFIRMATION_COLLECTION,
				rkey: GROUP_CONFIRMATION_RKEY,
				record: { $type: GROUP_CONFIRMATION_COLLECTION, createdAt: now.toISOString() }
			}
		});
		return 'written';
	} catch (e) {
		// The reference PDS's name for a record already there.
		if (e instanceof XrpcError && e.status === 400 && e.error === 'RecordAlreadyExists') {
			return 'present';
		}
		throw e;
	}
}

/** `skipped` when the session lacks the grant. */
export async function deleteConfirmation(
	member: CallerSession,
	groupDid: string
): Promise<'deleted' | 'skipped'> {
	if (!holdsConfirmationGrant(member.scope, 'delete', groupDid)) return 'skipped';
	await xrpc(member.handle, 'com.atproto.space.deleteRecord', {
		body: {
			space: membersSpaceUri(groupDid),
			repo: member.did,
			collection: GROUP_CONFIRMATION_COLLECTION,
			rkey: GROUP_CONFIRMATION_RKEY
		}
	});
	return 'deleted';
}

/** On a member's visit. A failure leaves them unconfirmed until a later visit writes it. */
export async function confirmMembership(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await writeConfirmation(member, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did} has no confirmation in ${groupDid} yet: ${errorKind(e)}`);
	}
}

/** Before a leave, while the host still counts them a member, as the spec asks. A confirmation
 *  with no membership confirms nothing, so a failure does not stop the leave. */
export async function withdrawConfirmation(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await deleteConfirmation(member, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s confirmation in ${groupDid} stays: ${errorKind(e)}`);
	}
}

// The member's own half of a membership: their `org.atgrp.confirmation`, in their repo in the
// group's members space, written through their own PDS. The group writes the membership; the
// confirmation says the member agrees to it, so it is written only for an act of theirs: joining
// an open group here, asking here to join one whose admins then admit them (the first visit after
// writes it, by a note of the request kept here), or confirming on the group's page. Never for
// merely opening a page, which a preload or another site's link can do; deleted when they leave.
import { env } from 'cloudflare:workers';
import type { CallerSession } from '#lib/private-events/server/caller.js';
import type { SpaceReader } from '#lib/spaces/server/space-read.js';
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

/** For a member's own act. A failure leaves them unconfirmed, and the group's page offers it. */
export async function confirmMembership(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await writeConfirmation(member, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did} has no confirmation in ${groupDid} yet: ${errorKind(e)}`);
	}
}

/** Whether the member's confirmation is in their repo, read with their own access. */
export async function hasConfirmation(
	reader: SpaceReader,
	groupDid: string,
	memberDid: string
): Promise<boolean> {
	const found = await reader.get({
		space: membersSpaceUri(groupDid),
		repo: memberDid,
		collection: GROUP_CONFIRMATION_COLLECTION,
		rkey: GROUP_CONFIRMATION_RKEY
	});
	return found !== null;
}

// A request to join made here, noted until the host admits it, so the first visit after writes the
// confirmation: the spec has no way to read a request back.

const REQUESTED_PREFIX = 'group:join-requested:';
/** Long enough for admins to decide; past it, the page offers confirming instead. */
const REQUESTED_TTL_SECONDS = 90 * 24 * 60 * 60;

const requestedKey = (personDid: string, groupDid: string) =>
	`${REQUESTED_PREFIX}${personDid}/${groupDid}`;

export async function rememberJoinRequest(personDid: string, groupDid: string): Promise<void> {
	await env.OAUTH_SESSIONS?.put(requestedKey(personDid, groupDid), '1', {
		expirationTtl: REQUESTED_TTL_SECONDS
	});
}

/** False when it could not be read: then the page offers confirming. */
export async function joinRequested(personDid: string, groupDid: string): Promise<boolean> {
	const kept = await env.OAUTH_SESSIONS?.get(requestedKey(personDid, groupDid), 'text').catch(
		() => null
	);
	return kept !== null && kept !== undefined;
}

export async function forgetJoinRequest(personDid: string, groupDid: string): Promise<void> {
	await env.OAUTH_SESSIONS?.delete(requestedKey(personDid, groupDid)).catch((e) => {
		console.warn(`[groups] ${personDid}'s request to ${groupDid} was not forgotten:`, e);
	});
}

/** On the first visit after the host admitted a request made here: the confirmation, then the
 *  note forgotten. A failure keeps the note, for the next visit. */
export async function confirmAdmitted(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await writeConfirmation(member, groupDid);
		await forgetJoinRequest(member.did, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did} has no confirmation in ${groupDid} yet: ${errorKind(e)}`);
	}
}

/** Once the host has taken a leave. A confirmation with no membership confirms nothing, so a
 *  failure here does not undo the leave. */
export async function withdrawConfirmation(member: CallerSession, groupDid: string): Promise<void> {
	try {
		await deleteConfirmation(member, groupDid);
	} catch (e) {
		console.warn(`[groups] ${member.did}'s confirmation in ${groupDid} stays: ${errorKind(e)}`);
	}
}

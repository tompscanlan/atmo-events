// A person's own acts at the group host: join, cancel a request, leave, and the list of their
// groups. Each goes to the host as the person, by service auth their PDS signs for the host's DID
// and the exact method, as making a group does (./create.ts). The host decides every one: there is
// no check here it does not also make.
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { fetchOtherServer } from '#lib/spaces/server/other-servers.js';
import {
	ACTOR_GROUPS_NSID,
	CANCEL_JOIN_REQUEST_NSID,
	LEAVE_GROUP_NSID,
	REQUEST_JOIN_NSID
} from '../scopes';
import { withdrawConfirmation } from './confirmation';
import { groupHostInfo } from './host-api';
import { answerError, readXrpc, XrpcError } from './xrpc';

const GET_SERVICE_AUTH = 'com.atproto.server.getServiceAuth';

/** Why the host did not do what the person asked, each worded for them on the group's page. */
export type GroupActionRefusal =
	/** The spec's: the group joins by invitation only. */
	| 'join-closed'
	/** The spec's: the host has no such group. */
	| 'group-not-found'
	/** The host's own `LastConfigurer`: the only one left who could run the group may not leave. */
	| 'last-admin'
	/** Their PDS would not vouch for them to the host: the permission is missing. */
	| 'no-permission';

export class GroupActionRefused extends Error {
	constructor(readonly reason: GroupActionRefusal) {
		super(`the group host refused: ${reason}`);
		this.name = 'GroupActionRefused';
	}
}

const REFUSALS: Record<string, GroupActionRefusal> = {
	JoinClosed: 'join-closed',
	GroupNotFound: 'group-not-found',
	// The group host's own name, not in the spec's leaveGroup lexicon.
	LastConfigurer: 'last-admin'
};

type HostRequest = { body: Record<string, unknown> } | { query: Record<string, string> };

/** Calls `nsid` at the group host as the person. A refusal the person can act on throws
 *  `GroupActionRefused`; any other failure an `XrpcError`. */
async function asPerson(
	caller: CallerSession,
	nsid: string,
	request: HostRequest
): Promise<Record<string, unknown>> {
	const host = await groupHostInfo();
	const auth = await readXrpc(
		await caller.handle(
			`/xrpc/${GET_SERVICE_AUTH}?${new URLSearchParams({ aud: host.did, lxm: nsid })}`,
			{ method: 'GET' }
		)
	);
	if (!auth.ok) {
		console.warn(`[groups] ${caller.did}'s PDS gave no service auth for ${nsid}: ${auth.status}`);
		if (auth.status === 403 || auth.error === 'ScopeMissingError') {
			throw new GroupActionRefused('no-permission');
		}
		throw answerError(GET_SERVICE_AUTH, auth);
	}
	if (typeof auth.data.token !== 'string') throw new Error(`${GET_SERVICE_AUTH} returned no token`);

	const authorization = `Bearer ${auth.data.token}`;
	const res =
		'query' in request
			? await fetchOtherServer(
					new URL(`/xrpc/${nsid}?${new URLSearchParams(request.query)}`, host.origin),
					{ method: 'GET', headers: { authorization } }
				)
			: await fetchOtherServer(new URL(`/xrpc/${nsid}`, host.origin), {
					method: 'POST',
					headers: { authorization, 'content-type': 'application/json' },
					body: JSON.stringify(request.body)
				});
	const answer = await readXrpc(res);
	if (answer.ok) return answer.data;
	const reason = answer.error ? REFUSALS[answer.error] : undefined;
	if (reason) throw new GroupActionRefused(reason);
	throw answerError(nsid, answer);
}

export type JoinOutcome = 'joined' | 'pending';

/** An open group admits at once; one that approves its members queues the request, and asking
 *  again is answered with the request still waiting. A member is answered with their membership.
 *  The confirmation is written on their next visit to the group's page, once the host's records
 *  say they are a member. */
export async function requestJoin(
	caller: CallerSession,
	groupDid: string,
	message: string | null
): Promise<JoinOutcome> {
	const answer = await asPerson(caller, REQUEST_JOIN_NSID, {
		body: { group: groupDid, ...(message ? { message } : {}) }
	});
	if (answer.status === 'admitted') return 'joined';
	if (answer.status === 'pending') return 'pending';
	throw new Error(`${REQUEST_JOIN_NSID} answered status ${String(answer.status)}`);
}

/** Gone at the host either way: withdrawn now, or already decided (`JoinRequestNotFound`). */
export async function cancelJoinRequest(caller: CallerSession, groupDid: string): Promise<void> {
	try {
		await asPerson(caller, CANCEL_JOIN_REQUEST_NSID, { body: { group: groupDid } });
	} catch (e) {
		if (e instanceof XrpcError && e.error === 'JoinRequestNotFound') return;
		throw e;
	}
}

/** The confirmation goes first, as the spec asks, while the host still counts them a member. Not a
 *  member already (the host's own `NotAMember`) is what they asked for. */
export async function leaveGroup(caller: CallerSession, groupDid: string): Promise<void> {
	await withdrawConfirmation(caller, groupDid);
	try {
		await asPerson(caller, LEAVE_GROUP_NSID, { body: { group: groupDid } });
	} catch (e) {
		if (e instanceof XrpcError && e.error === 'NotAMember') return;
		throw e;
	}
}

export interface ActorGroup {
	did: string;
	handle: string;
	/** Only when the person may read the group's meta space. */
	displayName: string | null;
}

const ACTOR_GROUPS_LIMIT = 100;
const MAX_ACTOR_GROUP_PAGES = 5;

/** The groups the person is in at the group host. The spec has no way to list them, so this is the
 *  host's own `org.atgrp.internal.getActorGroups`, and the one place that calls it. */
export async function actorGroups(caller: CallerSession): Promise<ActorGroup[]> {
	const groups: ActorGroup[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_ACTOR_GROUP_PAGES; page++) {
		const answer = await asPerson(caller, ACTOR_GROUPS_NSID, {
			query: { actor: caller.did, limit: String(ACTOR_GROUPS_LIMIT), ...(cursor ? { cursor } : {}) }
		});
		const listed = Array.isArray(answer.groups) ? answer.groups : [];
		for (const entry of listed) {
			const { did, handle, displayName } = (entry ?? {}) as Record<string, unknown>;
			if (typeof did !== 'string' || !did.startsWith('did:') || typeof handle !== 'string') {
				continue;
			}
			const name = typeof displayName === 'string' ? displayName.trim() : '';
			groups.push({ did, handle, displayName: name || null });
		}
		const next = typeof answer.cursor === 'string' && answer.cursor ? answer.cursor : undefined;
		if (!next || next === cursor || listed.length === 0) break;
		cursor = next;
	}
	return groups;
}

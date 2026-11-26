// Making a group from this site. The group host makes the group's account, its meta and members
// spaces, its about record and config, the founder's admin membership and, for a public group, its
// declaration; this site then links it as any group is linked, with the new group as the sign-in's
// login hint. Between the two the group exists but this site cannot act for it yet, so who made it
// is noted in KV until the link is done: there is no table to hold it.
import { env } from 'cloudflare:workers';
import type { CallerSession } from '#lib/private-events/server/caller.js';
import { fetchOtherServer } from '#lib/spaces/server/other-servers.js';
import { groupAddressLabel, groupDescription, groupJoinPolicy, groupName } from '../fields';
import type { GroupJoinPolicy } from '../ids';
import { ACTOR_GROUPS_NSID, CREATE_GROUP_NSID, holdsRpc } from '../scopes';
import type { GroupWriter } from './context';
import { unlistGroup } from './group';
import { actorGroups } from './host';
import type { GroupHostInfo } from './host-api';
import { listKeys } from './kv';
import { groupHandle, groupSession, hasGroupSession } from './sign-in';
import { errorKind, readXrpc } from './xrpc';

export interface NewGroup {
	name: string;
	/** The label the group's address starts with. */
	address: string;
	description: string | null;
	joinPolicy: GroupJoinPolicy;
	/** Whether anyone may read its meta space: its name and description. */
	public: boolean;
	/** On the groups list; only a public group may be. */
	listed: boolean;
}

/** Null for anything that is not a whole, valid new group. */
export function parseNewGroup(value: Record<string, unknown>): NewGroup | null {
	const name = groupName(value.name);
	const address = groupAddressLabel(value.address);
	const description = groupDescription(value.description);
	const joinPolicy = groupJoinPolicy(value.joinPolicy);
	if (!name || !address || description === undefined || !joinPolicy) return null;
	if (typeof value.public !== 'boolean' || typeof value.listed !== 'boolean') return null;
	return {
		name,
		address,
		description,
		joinPolicy,
		public: value.public,
		listed: value.public && value.listed
	};
}

/** Why a group was not made, each worded for the person on the form. */
export type NotCreatedReason =
	/** The host makes groups only for the people it names (`GROUP_FOUNDERS`). */
	| 'not-allowed'
	| 'address-taken'
	| 'address-invalid'
	/** The host refused the fields themselves. */
	| 'invalid'
	/** The person's PDS would not vouch for them to the host: the permission is missing. */
	| 'no-permission'
	| 'unavailable';

export class GroupNotCreated extends Error {
	/** `madeMaybe`: the host may have made it all the same, as when its answer did not come. */
	constructor(
		readonly reason: NotCreatedReason,
		readonly madeMaybe = false
	) {
		super(`the group was not made: ${reason}`);
		this.name = 'GroupNotCreated';
	}
}

const GET_SERVICE_AUTH = 'com.atproto.server.getServiceAuth';

// The host's own names for its refusals, from its org.atgrp.internal.createGroup lexicon, not the
// spec's; and the generic InvalidRequest for fields its lexicons refuse.
const REFUSALS: Record<string, NotCreatedReason> = {
	NotAllowed: 'not-allowed',
	HandleTaken: 'address-taken',
	InvalidHandle: 'address-invalid',
	InvalidRequest: 'invalid'
};

/** The one call that is the group host's own rather than the spec's: its
 *  `org.atgrp.internal.createGroup`, as the person, by service auth their PDS signs for the host's
 *  DID. The spec's way to make a group is OAuth `prompt=create` at the host, which this host does
 *  not take; switching to it changes this function and the sign-in's callback only. Throws
 *  `GroupNotCreated` for a refusal the person can act on. */
export async function createGroupAtHost(
	caller: CallerSession,
	group: NewGroup,
	host: GroupHostInfo
): Promise<{ did: string; handle: string }> {
	// The person's PDS not answering, or the host, is the host that could not be reached, never a
	// failed page.
	const auth = await caller
		.handle(
			`/xrpc/${GET_SERVICE_AUTH}?${new URLSearchParams({ aud: host.did, lxm: CREATE_GROUP_NSID })}`,
			{ method: 'GET' }
		)
		.then(readXrpc)
		.catch((e: unknown) => {
			console.warn(`[groups] ${caller.did}'s PDS did not answer for service auth: ${errorKind(e)}`);
			throw new GroupNotCreated('unavailable');
		});
	if (!auth.ok || typeof auth.data.token !== 'string') {
		const refused = !auth.ok && (auth.status === 403 || auth.error === 'ScopeMissingError');
		console.warn(
			`[groups] ${caller.did}'s PDS gave no service auth for ${CREATE_GROUP_NSID}: ${auth.status}`
		);
		throw new GroupNotCreated(refused ? 'no-permission' : 'unavailable');
	}

	const handle = `${group.address}${host.domain}`;
	let made: Awaited<ReturnType<typeof readXrpc>>;
	try {
		const res = await fetchOtherServer(new URL(`/xrpc/${CREATE_GROUP_NSID}`, host.origin), {
			method: 'POST',
			headers: { authorization: `Bearer ${auth.data.token}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				handle,
				displayName: group.name,
				...(group.description ? { description: group.description } : {}),
				joinPolicy: group.joinPolicy,
				metaPublicRead: group.public
			})
		});
		made = await readXrpc(res);
	} catch (e) {
		// Given up on, or cut off: the host may still have made it.
		console.warn(`[groups] ${CREATE_GROUP_NSID} for ${caller.did} had no answer: ${errorKind(e)}`);
		throw new GroupNotCreated('unavailable', true);
	}
	if (!made.ok) {
		console.warn(`[groups] ${CREATE_GROUP_NSID} for ${caller.did}: ${made.status} ${made.error}`);
		throw new GroupNotCreated((made.error && REFUSALS[made.error]) || 'unavailable');
	}
	const did = made.data.did;
	if (typeof did !== 'string' || !did.startsWith('did:')) {
		throw new Error(`${CREATE_GROUP_NSID} returned no DID`);
	}
	console.info(`[groups] ${caller.did} made ${did} at ${host.origin}`);
	return { did, handle };
}

/** The group at the address the person asked for, when it is one they made a moment ago that this
 *  site never noted: a second press of the button, or an answer from the host that never came.
 *  The host's own list of the person's groups says they are in it, they have no link to it here,
 *  and its name is the one they typed. Null when it is not, or when that can't be told: their
 *  sign-in can't ask for their groups, or the host did not answer. */
export async function ownGroupNotNoted(
	caller: CallerSession,
	group: NewGroup,
	host: GroupHostInfo
): Promise<{ did: string; handle: string } | null> {
	if (!holdsRpc(caller.scope, ACTOR_GROUPS_NSID)) return null;
	const handle = `${group.address}${host.domain}`;
	try {
		const theirs = (await actorGroups(caller)).find(
			(found) => found.handle.toLowerCase() === handle
		);
		if (!theirs || theirs.displayName !== group.name) return null;
		if (await hasGroupSession(theirs.did, caller.did)) return null;
		return { did: theirs.did, handle };
	} catch (e) {
		console.warn(
			`[groups] ${caller.did}'s groups could not be checked for ${handle}: ${errorKind(e)}`
		);
		return null;
	}
}

// ---- a group made here, until its first link is done ----

const SETUP_PREFIX = 'group:setup:';
/** Long enough to come back to; a group never linked is the host's to clear up. */
const SETUP_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface UnfinishedGroup {
	did: string;
	handle: string;
	public: boolean;
	listed: boolean;
}

const setupPrefix = (personDid: string) => `${SETUP_PREFIX}${personDid}/`;

export async function rememberUnfinished(personDid: string, group: UnfinishedGroup) {
	await env.OAUTH_SESSIONS.put(setupPrefix(personDid) + group.did, JSON.stringify(group), {
		expirationTtl: SETUP_TTL_SECONDS
	});
}

function unfinished(value: unknown): UnfinishedGroup | null {
	if (!value || typeof value !== 'object') return null;
	const { did, handle, public: isPublic, listed } = value as Record<string, unknown>;
	if (typeof did !== 'string' || !did.startsWith('did:') || typeof handle !== 'string') {
		return null;
	}
	return { did, handle, public: isPublic === true, listed: listed === true };
}

/** Groups the person made here and has not linked yet. */
export async function unfinishedGroups(personDid: string): Promise<UnfinishedGroup[]> {
	const kv = env.OAUTH_SESSIONS;
	if (!kv) return [];
	const keys = await listKeys(kv, setupPrefix(personDid));
	const groups = await Promise.all(
		keys.map(async (did) => unfinished(await kv.get(setupPrefix(personDid) + did, 'json')))
	);
	return groups.filter((group): group is UnfinishedGroup => group !== null);
}

export async function unfinishedGroup(
	personDid: string,
	groupDid: string
): Promise<UnfinishedGroup | null> {
	const kept = await env.OAUTH_SESSIONS?.get(setupPrefix(personDid) + groupDid, 'json');
	return unfinished(kept);
}

/** What a group's first link finishes, as the group: a public group its maker asked not to list
 *  comes off the list, where the host put it when it made the group. False when nothing was left to
 *  do. Throws on a stop, and keeps the note, so running it again finishes it. */
export async function finishSetup(writer: GroupWriter, personDid: string): Promise<boolean> {
	const group = await unfinishedGroup(personDid, writer.did);
	if (!group) return false;
	if (group.public && !group.listed) await unlistGroup(writer.handle, writer.did);
	await env.OAUTH_SESSIONS.delete(setupPrefix(personDid) + writer.did);
	return true;
}

/** After a link: finishes a group the person made here, if it is one. 'created' when it was, and
 *  is done; 'unfinished' when it was and is not yet; null for any other group. */
export async function finishCreatedGroup(
	groupDid: string,
	personDid: string
): Promise<'created' | 'unfinished' | null> {
	if (!(await unfinishedGroup(personDid, groupDid))) return null;
	try {
		const session = await groupSession(groupDid, personDid);
		if (!session) return 'unfinished';
		await finishSetup({ did: groupDid, handle: groupHandle(session, personDid) }, personDid);
		return 'created';
	} catch (e) {
		console.warn(`[groups] setting up ${groupDid} did not finish:`, e);
		return 'unfinished';
	}
}

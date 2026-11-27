// Signing in as a group: an OAuth session on the group's account, approved at its group
// host by someone who holds a role there, and kept under the person here who started it.
// Those are meant to be the same person, but the host signs in whoever approves, so someone
// who can also sign in as another account could approve as that one. It is a second
// client beside the library's, with its own client_id, so its sessions are never ones a
// `did` cookie restores and its sign-in state never reaches the library's callback, which
// would finish any state in its store and sign the browser in as the group.
import { env } from 'cloudflare:workers';
import {
	OAuthClient,
	scope,
	type ClientAssertionPrivateJwk,
	type OAuthSession,
	type Store,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { oauthRequestLock } from '#lib/atproto/server/oauth.js';
import { oauthOrigin } from '#lib/atproto/server/origin.js';
import { timeLimitedNetwork } from '#lib/spaces/server/other-servers.js';
import { GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION } from '../ids';
import {
	GROUP_META_READ_SCOPE,
	GROUP_POLICY_SCOPE,
	GROUP_SETTINGS_SCOPES,
	MEMBERS_ONLY_SCOPES,
	ROSTER_SCOPES
} from '../scopes';
import { CREATE_IN_THIS_BUILD, ROSTER_IN_THIS_BUILD, SETTINGS_IN_THIS_BUILD } from '../build';
import { groupsEnabled } from './enabled';
import { listKeys, prefixedKV } from './kv';
import type { XrpcHandle } from './xrpc';

export const GROUP_CLIENT_METADATA_PATH = '/oauth/group/client-metadata.json';
export const GROUP_CALLBACK_PATH = '/oauth/group/callback';
/** The library's, which serves the same key. */
const JWKS_PATH = '/oauth/jwks.json';

const SESSION_PREFIX = 'group:session:';
/** The scope this site asked for when each link was approved, beside the session, so a link
 *  approved before the asked scope grew can be told from one whose roles withheld the rest. */
const ASKED_PREFIX = 'group:asked:';
const STATE_PREFIX = 'group:state:';
const STATE_TTL_SECONDS = 600;

/** The host keeps or drops each scope whole, so the meta read is its own scope and
 *  survives for a member whose roles grant no writes, and each of the settings', the members
 *  page's and members-only events' writes is its own too. Every scope for one space names the
 *  same key, since the host's approval page cannot show one space as two rows. The members page's
 *  and the settings' are asked for only in a build that has them (../build.ts); without the
 *  settings, the meta space's policy is still asked for while making a group here is in it, whose
 *  setting up makes a group public. Listing a group needs none of them: it writes the group's
 *  declaration, in its repo. */
export function groupSessionScope(
	roster: boolean,
	settings: boolean = SETTINGS_IN_THIS_BUILD,
	create: boolean = CREATE_IN_THIS_BUILD
): string {
	return [
		'atproto',
		GROUP_META_READ_SCOPE,
		scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
		scope.blob({ accept: ['image/*'] }),
		...(settings ? GROUP_SETTINGS_SCOPES : create ? [GROUP_POLICY_SCOPE] : []),
		...(roster ? ROSTER_SCOPES : []),
		...MEMBERS_ONLY_SCOPES
	].join(' ');
}

export const GROUP_SESSION_SCOPE = groupSessionScope(ROSTER_IN_THIS_BUILD);

/** A loopback client cannot have a second client_id, and only one group host is served. */
export function groupSignInAvailable(): boolean {
	return Boolean(
		env.OAUTH_PUBLIC_URL && env.CLIENT_ASSERTION_KEY && env.OAUTH_SESSIONS && groupsEnabled()
	);
}

// A DID holds no `/`.
const personPrefix = (personDid: string) => `${SESSION_PREFIX}${personDid}/`;

// Per binding, so a test's fresh env gets fresh clients; per person, since each person's
// sessions are their own store. Kept per isolate for the metadata and DPoP nonce caches.
const clients = new WeakMap<KVNamespace, Map<string, OAuthClient>>();

/** `personDid` null is the client that serves the metadata, which holds no session. */
function clientFor(personDid: string | null): OAuthClient {
	const kv = env.OAUTH_SESSIONS;
	let byPerson = clients.get(kv);
	if (!byPerson) clients.set(kv, (byPerson = new Map()));
	const key = personDid ?? '';
	let client = byPerson.get(key);
	if (!client) {
		client = buildClient(key, prefixedKV<Did, StoredSession>(kv, personPrefix(key)));
		byPerson.set(key, client);
	}
	return client;
}

/** `lock` names the client's own request lock. */
function buildClient(lock: string, sessions: Store<Did, StoredSession>): OAuthClient {
	// The library's origin, so a trailing slash in the setting is the same client.
	const origin = oauthOrigin(env.OAUTH_PUBLIC_URL);
	// Every call to the group host, its sign-in and the group's own session alike, with the same
	// time limit as other servers: a page waits on them.
	const network = timeLimitedNetwork();
	return new OAuthClient({
		metadata: {
			client_id: origin + GROUP_CLIENT_METADATA_PATH,
			redirect_uris: [origin + GROUP_CALLBACK_PATH],
			scope: GROUP_SESSION_SCOPE,
			jwks_uri: origin + JWKS_PATH
		},
		keyset: [JSON.parse(env.CLIENT_ASSERTION_KEY) as ClientAssertionPrivateJwk],
		actorResolver: createActorResolver({ network }),
		fetch: network.fetch as typeof fetch,
		stores: {
			sessions,
			states: prefixedKV<string, StoredState>(env.OAUTH_SESSIONS, STATE_PREFIX, {
				ttl: STATE_TTL_SECONDS
			})
		},
		requestLock: (name, operation) => oauthRequestLock(`group:${lock}:${name}`, operation)
	});
}

/** Revokes a session a new link replaced in the store, so its grant does not stay live at the
 *  group's PDS until it expires. Through a client that holds that session alone, so the new one,
 *  stored under the same key, is left as it is. Logged, not thrown: the new link works either way. */
async function revokeReplaced(
	groupDid: string,
	personDid: string,
	replaced: StoredSession
): Promise<void> {
	const held = new Map<Did, StoredSession>([[groupDid as Did, replaced]]);
	const only: Store<Did, StoredSession> = {
		get: (did) => held.get(did),
		set: (did, session) => void held.set(did, session),
		delete: (did) => void held.delete(did),
		clear: () => held.clear()
	};
	try {
		await buildClient(`${personDid}:replaced`, only).revoke(groupDid as Did);
	} catch (e) {
		console.warn(`[groups] revoking ${personDid}'s replaced session for ${groupDid} failed:`, e);
	}
}

export function groupClientMetadata() {
	return clientFor(null).metadata;
}

interface LinkState {
	groupDid: string;
	by: string;
}

function linkState(value: unknown): LinkState | null {
	if (!value || typeof value !== 'object') return null;
	const { groupDid, by } = value as Record<string, unknown>;
	if (typeof groupDid !== 'string' || !groupDid.startsWith('did:')) return null;
	if (typeof by !== 'string' || !by.startsWith('did:')) return null;
	return { groupDid, by };
}

/** Where to send the browser. The host signs in whoever approves, at their own PDS, and
 *  turns them away unless they hold a role in the group. The group is the request's
 *  `login_hint`, which the client takes from the account it signs in as; the host offers
 *  that group to approve. Nothing names the person to the host. */
export async function startGroupLink(groupDid: string, personDid: string): Promise<URL> {
	const { url } = await clientFor(personDid).authorize({
		target: { type: 'account', identifier: groupDid as Did },
		scope: GROUP_SESSION_SCOPE,
		state: { groupDid, by: personDid } satisfies LinkState
	});
	return url;
}

export type GroupLinkResult =
	{ ok: true; groupDid: string } | { ok: false; groupDid: string | null; reason: string };

/** Only the person who started the link finishes it. The state is checked against who is
 *  signed in, not the browser, so any browser signed in as them can. */
export async function finishGroupLink(
	params: URLSearchParams,
	signedInDid: string | null
): Promise<GroupLinkResult> {
	const stateId = params.get('state');
	const states = prefixedKV<string, StoredState>(env.OAUTH_SESSIONS, STATE_PREFIX);
	const stored = stateId ? await states.get(stateId) : undefined;
	const link = linkState(stored?.userState);
	if (!stateId || !link) return { ok: false, groupDid: null, reason: 'unknown or expired state' };

	if (signedInDid !== link.by) {
		// Single use, as the client's own callback would make it.
		await states.delete(stateId);
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: `started by ${link.by}, finished by ${signedInDid ?? 'nobody'}`
		};
	}

	const client = clientFor(link.by);
	// A link already stored here is replaced by this one; its grant is revoked once this one is in.
	const replaced = await prefixedKV<Did, StoredSession>(
		env.OAUTH_SESSIONS,
		personPrefix(link.by)
	).get(link.groupDid as Did);
	let session: OAuthSession;
	try {
		({ session } = await client.callback(params));
	} catch (e) {
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: e instanceof Error ? e.message : 'failed'
		};
	}
	if (session.did !== link.groupDid) {
		await client.revoke(session.did).catch((e) => {
			console.error(`[groups] revoking a session for ${session.did} failed:`, e);
		});
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: `${session.did} was authorized, not ${link.groupDid}`
		};
	}
	await env.OAUTH_SESSIONS.put(askedKey(link.by, link.groupDid), GROUP_SESSION_SCOPE);
	if (replaced) await revokeReplaced(link.groupDid, link.by, replaced);
	return { ok: true, groupDid: link.groupDid };
}

const askedKey = (personDid: string, groupDid: string) => `${ASKED_PREFIX}${personDid}/${groupDid}`;

/** Whether the person approved their link to the group for what this site asks for now. A link
 *  from before the asked scope last grew may be missing what approving again would bring. */
export async function linkAskedCurrentScope(groupDid: string, personDid: string): Promise<boolean> {
	const asked = await env.OAUTH_SESSIONS?.get(askedKey(personDid, groupDid), 'text');
	return asked === GROUP_SESSION_SCOPE;
}

export async function hasGroupSession(groupDid: string, personDid: string): Promise<boolean> {
	if (!env.OAUTH_SESSIONS) return false;
	return (await env.OAUTH_SESSIONS.get(personPrefix(personDid) + groupDid, 'text')) !== null;
}

/** The person's session as the group, or null when they have not linked it. Not refreshed
 *  here: the session refreshes its own token on first use. */
export async function groupSession(
	groupDid: string,
	personDid: string
): Promise<OAuthSession | null> {
	if (!groupSignInAvailable() || !(await hasGroupSession(groupDid, personDid))) return null;
	return clientFor(personDid).restore(groupDid as Did, { refresh: false });
}

/** Sends as the group, with one log line per write, never the token. */
export function groupHandle(session: OAuthSession, personDid: string): XrpcHandle {
	return async (pathname, init) => {
		const res = await session.handle(pathname, init);
		if ((init.method ?? 'GET').toUpperCase() !== 'GET') {
			const nsid = pathname.replace(/^\/xrpc\//, '').split('?')[0];
			console.info(`[groups] ${session.did} ${nsid} for ${personDid}: ${res.status}`);
		}
		return res;
	};
}

/** The groups the person has linked, by DID, from this site's own record of their links. */
export async function linkedGroups(personDid: string): Promise<string[]> {
	if (!groupSignInAvailable()) return [];
	return (await listKeys(env.OAUTH_SESSIONS, personPrefix(personDid))).filter((did) =>
		did.startsWith('did:')
	);
}

/** Revoked at the group's PDS when it answers; forgotten here either way. */
export async function unlinkGroup(groupDid: string, personDid: string): Promise<void> {
	try {
		await clientFor(personDid).revoke(groupDid as Did);
	} catch (e) {
		console.warn(`[groups] revoking ${personDid}'s session for ${groupDid} failed:`, e);
	} finally {
		await env.OAUTH_SESSIONS.delete(personPrefix(personDid) + groupDid);
		await env.OAUTH_SESSIONS.delete(askedKey(personDid, groupDid));
	}
}

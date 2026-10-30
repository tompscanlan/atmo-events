// Signing in as a group: an OAuth session on the group's account, approved at its group
// host by a person who holds a role there, and kept under that person. It is a second
// client beside the library's, with its own client_id, so its sessions are never ones a
// `did` cookie restores and its sign-in state never reaches the library's callback, which
// would finish any state in its store and sign the browser in as the group.
import { env } from 'cloudflare:workers';
import {
	OAuthClient,
	scope,
	type ClientAssertionPrivateJwk,
	type OAuthSession,
	type StoredSession,
	type StoredState
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { createActorResolver } from '@svelte-atproto/oauth/network';
import { oauthRequestLock } from '#lib/atproto/server/oauth.js';
import { atprotoNetwork } from '#lib/atproto/network.js';
import { GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION, META_SPACE_TYPE } from '../ids';
import { listKeys, prefixedKV } from './kv';
import type { XrpcHandle } from './xrpc';

export const GROUP_CLIENT_METADATA_PATH = '/oauth/group/client-metadata.json';
export const GROUP_CALLBACK_PATH = '/oauth/group/callback';
/** The library's, which serves the same key. */
const JWKS_PATH = '/oauth/jwks.json';

const SESSION_PREFIX = 'group:session:';
const STATE_PREFIX = 'group:state:';
const STATE_TTL_SECONDS = 600;

/** The host keeps or drops each scope whole, so the meta read is its own scope and
 *  survives for a member whose roles grant no writes. */
export const GROUP_SESSION_SCOPE = [
	'atproto',
	`space:${META_SPACE_TYPE}?authority=self&action=read`,
	scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
	scope.blob({ accept: ['image/*'] })
].join(' ');

/** A loopback client cannot have a second client_id, and only one group host is served. */
export function groupSignInAvailable(): boolean {
	return Boolean(
		env.OAUTH_PUBLIC_URL && env.CLIENT_ASSERTION_KEY && env.OAUTH_SESSIONS && env.GROUP_HOST_URL
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
		const origin = env.OAUTH_PUBLIC_URL;
		client = new OAuthClient({
			metadata: {
				client_id: origin + GROUP_CLIENT_METADATA_PATH,
				redirect_uris: [origin + GROUP_CALLBACK_PATH],
				scope: GROUP_SESSION_SCOPE,
				jwks_uri: origin + JWKS_PATH
			},
			keyset: [JSON.parse(env.CLIENT_ASSERTION_KEY) as ClientAssertionPrivateJwk],
			actorResolver: createActorResolver({ network: atprotoNetwork() }),
			stores: {
				sessions: prefixedKV<Did, StoredSession>(kv, personPrefix(key)),
				states: prefixedKV<string, StoredState>(kv, STATE_PREFIX, { ttl: STATE_TTL_SECONDS })
			},
			requestLock: (name, operation) => oauthRequestLock(`group:${key}:${name}`, operation)
		});
		byPerson.set(key, client);
	}
	return client;
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

/** Where to send the browser. The host signs the person in at their own PDS and turns them
 *  away unless they hold a role in the group. */
export async function startGroupLink(groupDid: string, personDid: string): Promise<URL> {
	const { url } = await clientFor(personDid).authorize({
		target: { type: 'account', identifier: groupDid as Did },
		scope: GROUP_SESSION_SCOPE,
		state: { groupDid, by: personDid } satisfies LinkState
	});
	// A hint for the host's sign-in page, which fills in the person's handle from it.
	url.searchParams.set('gh_person', personDid);
	return url;
}

export type GroupLinkResult =
	{ ok: true; groupDid: string } | { ok: false; groupDid: string | null; reason: string };

/** Only the browser that started the link, still signed in as the same person, finishes it. */
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
	return { ok: true, groupDid: link.groupDid };
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

/** The groups the person has linked, by DID. */
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
	}
}

// Writing as a group. A group session is an OAuth session on the group's account that
// a person approved at the host; it is filed under that person and writes within their
// roles, which the host checks on every request.
//
// Group sessions have their own store prefix, `group:session:<person>/`: a sign-in
// session is keyed by DID too, so a shared store would let a sign-in as the group
// overwrite a group session, and a `did` cookie could restore one.
import { Client } from '@atcute/client';
import {
	scope,
	type OAuthClient,
	type OAuthSession,
	type StoredSession
} from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { KVStore } from '$lib/atproto/server/kv-store';
import { createOAuthClientWithSessions } from '$lib/atproto/server/oauth';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';

export type CredentialStoreEnv = Partial<App.Platform['env']>;

export const GROUP_SESSION_PREFIX = 'group:session:';

// A DID holds no `/`.
function personPrefix(personDid: string): string {
	return `${GROUP_SESSION_PREFIX}${personDid}/`;
}

export function groupSessionKey(groupDid: string, personDid: string): string {
	return personPrefix(personDid) + groupDid;
}

export function parseGroupSessionKey(key: string): { groupDid: string; personDid: string } | null {
	if (!key.startsWith(GROUP_SESSION_PREFIX)) return null;
	const [personDid, groupDid, ...rest] = key.slice(GROUP_SESSION_PREFIX.length).split('/');
	if (rest.length > 0 || !personDid?.startsWith('did:') || !groupDid?.startsWith('did:')) {
		return null;
	}
	return { groupDid, personDid };
}

/** The proposal's sets for the group's own records, and the group's public repo for
 *  its declaration and events. */
export const GROUP_SESSION_SCOPES: readonly string[] = [
	'include:group.opensocial.configure',
	'include:group.opensocial.manageSpaces',
	'include:group.opensocial.manageMembers',
	scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
	scope.blob({ accept: ['image/*'] })
];

/** What a link asks for, the create's included. */
export function groupSessionScope(): string {
	return ['atproto', ...GROUP_SESSION_SCOPES].join(' ');
}

/** It serves its own client metadata, so a link can ask for the group's scope, and it
 *  has a sessions store, so a link outlives the request that made it. */
export function groupLinkConfigured(env: CredentialStoreEnv | undefined): boolean {
	return Boolean(env?.OAUTH_PUBLIC_URL && env?.OAUTH_SESSIONS);
}

// Kept per isolate like the sign-in client, so its metadata and DPoP nonce caches last.
const linkClients = new WeakMap<KVNamespace, Map<string, OAuthClient>>();

export function groupLinkClient(
	env: CredentialStoreEnv | undefined,
	personDid: string
): OAuthClient {
	const kv = env?.OAUTH_SESSIONS;
	if (!kv) throw new Error('linking a group needs the OAUTH_SESSIONS store');
	let clients = linkClients.get(kv);
	if (!clients) linkClients.set(kv, (clients = new Map()));
	let client = clients.get(personDid);
	if (!client) {
		client = createOAuthClientWithSessions(
			env as App.Platform['env'],
			GROUP_SESSION_SCOPES,
			new KVStore<Did, StoredSession>(kv, { prefix: personPrefix(personDid) })
		);
		clients.set(personDid, client);
	}
	return client;
}

/** A read of the store only: it neither refreshes nor checks the session. */
export async function hasLinkedSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string,
	personDid: string
): Promise<boolean> {
	const kv = env?.OAUTH_SESSIONS;
	if (!kv) return false;
	return (await kv.get(groupSessionKey(groupDid, personDid), 'text')) !== null;
}

/** Restored without a refresh: the session refreshes its own token on first use. */
export async function linkedGroupSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string,
	personDid: string
): Promise<OAuthSession | null> {
	if (!(await hasLinkedSession(env, groupDid, personDid))) return null;
	return groupLinkClient(env, personDid).restore(groupDid as Did, { refresh: false });
}

export interface LinkedGroupCredential {
	kind: 'linked';
	/** Whose roles it writes within. */
	person: string;
	session: Pick<OAuthSession, 'did' | 'handle'>;
}

export type GroupCredential = LinkedGroupCredential;


export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string,
	personDid: string
): Promise<GroupCredential | null> {
	const session = await linkedGroupSession(env, groupDid, personDid);
	return session ? { kind: 'linked', person: personDid, session } : null;
}

/** Only the person can fix it, by linking from the group page. */
export class GroupCredentialError extends Error {
	constructor(
		readonly groupDid: string,
		readonly personDid: string
	) {
		super(
			`${personDid} has linked no group session for ${groupDid}, so this app cannot write as the group for them`
		);
		this.name = 'GroupCredentialError';
	}
}


export async function requireGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string,
	personDid: string
): Promise<GroupCredential> {
	const cred = await resolveGroupCredential(env, groupDid, personDid);
	if (!cred) throw new GroupCredentialError(groupDid, personDid);
	return cred;
}

type GroupTransport = {
	client: Client;
	handle: (pathname: string, init: RequestInit) => Promise<Response>;
	did: string;
};

// One line per write as the group, never the token.
function reportWrite(
	via: string,
	did: string,
	pathname: string,
	init: RequestInit,
	status: number
) {
	if ((init.method ?? 'GET').toUpperCase() === 'GET') return;
	const nsid = pathname.replace(/^\/xrpc\//, '').split('?')[0];
	console.info(`[group-session] ${did} ${nsid} via ${via}: ${status}`);
}

/** `handle` is there because the space methods are not in the generated lexicon set. A
 *  session stored under the wrong group fails loudly. */
export async function groupClient(
	cred: GroupCredential,
	expectDid: string
): Promise<GroupTransport> {
	const { session } = cred;
	if (session.did !== expectDid) {
		throw new Error(`linked group session authenticates ${session.did}, not ${expectDid}`);
	}
	const handle = async (pathname: string, init: RequestInit): Promise<Response> => {
		const res = await session.handle(pathname, init);
		reportWrite(`linked by ${cred.person}`, expectDid, pathname, init, res.status);
		return res;
	};
	return { client: new Client({ handler: handle }), handle, did: session.did };
}

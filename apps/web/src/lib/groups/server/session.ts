// Writing as a group: the credentials this app keeps for a group, and the one
// seam every request as the group goes through (`groupClient`).
//
// A credential is a group session: an OAuth session on the group's own account,
// which a person whose roles grant writes approves by signing in at the group's
// host and authorizing this app. A person holds one per group, filed under the
// person signed in to this app who started it, and it writes as the group within
// that person's roles: the host checks them on every request (proposal.md:93-99,
// per-user sessions). No one's session writes for anyone else. The one other
// credential is the session `createAccount` returns, which the create flow uses
// to set the new group up inside that one request and never stores.
//
// Group sessions live in their own store, under `group:session:<person>/` in the
// sign-in sessions namespace, keyed by group DID. A sign-in session is keyed by
// DID too, so sharing that store would let a sign-in as the group overwrite a
// group session with one that lacks the group's scope, and a link would leave a
// session a `did` cookie could restore.
//
// Every request as the group goes through `groupClient`. The human's OAuth
// session would author under the human's DID, and a repo write needs repo === the
// authenticated DID. A group session manages its own tokens.
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
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '../about-record';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_ROLE_COLLECTION,
	GROUP_SPACE_COLLECTION
} from '../members-record';
import { ABOUT_SPACE_TYPE, CALENDAR_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';

/** The parts of the platform env a group session reads: the sessions namespace,
 *  and for restoring a session, the OAuth client's settings. */
export type CredentialStoreEnv = Partial<App.Platform['env']>;

export const GROUP_SESSION_PREFIX = 'group:session:';

/** The prefix of `personDid`'s group sessions. A DID holds no `/`. */
function personPrefix(personDid: string): string {
	return `${GROUP_SESSION_PREFIX}${personDid}/`;
}

/** Where `personDid`'s session on `groupDid` is stored. */
export function groupSessionKey(groupDid: string, personDid: string): string {
	return personPrefix(personDid) + groupDid;
}

/** The group and the person a stored key names, or null for any other key. */
export function parseGroupSessionKey(key: string): { groupDid: string; personDid: string } | null {
	if (!key.startsWith(GROUP_SESSION_PREFIX)) return null;
	const [personDid, groupDid, ...rest] = key.slice(GROUP_SESSION_PREFIX.length).split('/');
	if (rest.length > 0 || !personDid?.startsWith('did:') || !groupDid?.startsWith('did:')) {
		return null;
	}
	return { groupDid, personDid };
}

const SELF = 'authority=self';

/** The group's own methods on its join requests, which take a group session. */
const LIST_JOIN_REQUESTS = 'group.opensocial.listJoinRequests';
const DENY_JOIN_REQUEST = 'group.opensocial.denyJoinRequest';

/** Reading a group space as the group. Reads are collection-independent. */
const readSpace = (spaceType: string) => `space:${spaceType}?${SELF}&action=read`;

/** Writing one collection's records in a group space as the group. */
const writeSpace = (spaceType: string, collection: string) =>
	`space:${spaceType}?${SELF}&collection=${collection}&action=create&action=update&action=delete`;

/** What a group session asks for: one item per space and collection atmo writes,
 *  each naming its space's type. A host keeps a requested item only when the
 *  person's roles cover all of it and drops the rest one by one, so small items
 *  leave a person with only some roles the writes those roles allow. `space:*`
 *  only for creating spaces, as the host grants it (proposal.md:213), and the two
 *  join-request methods (proposal.md, "Permission sets", manageMembers). The
 *  public repo's records (the declaration and public group events) and image
 *  uploads are what the host's `repo:` and `blob:` grants cover. A type named
 *  here must resolve where the session is asked for, so the calendar space's
 *  type is published there (devnet only today). */
export const GROUP_SESSION_SCOPES: readonly string[] = [
	readSpace(ABOUT_SPACE_TYPE),
	writeSpace(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION),
	writeSpace(ABOUT_SPACE_TYPE, GROUP_RULE_COLLECTION),
	writeSpace(ABOUT_SPACE_TYPE, GROUP_ACCESS_COLLECTION),
	readSpace(MEMBERS_SPACE_TYPE),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_MEMBERSHIP_COLLECTION),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_ROLE_COLLECTION),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_PERMISSIONS_COLLECTION),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_EVENT_PERMISSIONS_COLLECTION),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_SPACE_COLLECTION),
	writeSpace(MEMBERS_SPACE_TYPE, GROUP_ACCESS_COLLECTION),
	readSpace(CALENDAR_SPACE_TYPE),
	writeSpace(CALENDAR_SPACE_TYPE, GROUP_EVENT_COLLECTION),
	writeSpace(CALENDAR_SPACE_TYPE, GROUP_ACCESS_COLLECTION),
	`space:*?${SELF}&manage=create`,
	`rpc:${LIST_JOIN_REQUESTS}?aud=*`,
	`rpc:${DENY_JOIN_REQUEST}?aud=*`,
	scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
	scope.blob({ accept: ['image/*'] })
];

/** The scope a link asks for, the create's included. Nobody's asks for a
 *  space's member list or read policy: the group's host keeps neither apart from
 *  the access records. */
export function groupSessionScope(): string {
	return ['atproto', ...GROUP_SESSION_SCOPES].join(' ');
}

/** Whether this deployment can link a group: it serves its own client metadata,
 *  so a link can ask for the group's scope, and it has a sessions store, so a
 *  link outlives the request that made it. */
export function groupLinkConfigured(env: CredentialStoreEnv | undefined): boolean {
	return Boolean(env?.OAUTH_PUBLIC_URL && env?.OAUTH_SESSIONS);
}

// One client per person and sessions store, kept per isolate like the sign-in
// client, so its metadata and DPoP nonce caches survive between requests.
const linkClients = new WeakMap<KVNamespace, Map<string, OAuthClient>>();

/** The client that links groups for `personDid` and restores their sessions. */
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
		// The client reads the OAuth settings, which a deployment that links groups has.
		client = createOAuthClientWithSessions(
			env as App.Platform['env'],
			GROUP_SESSION_SCOPES,
			new KVStore<Did, StoredSession>(kv, { prefix: personPrefix(personDid) })
		);
		clients.set(personDid, client);
	}
	return client;
}

/** Whether `personDid` has a session on `groupDid` stored. A read of the store
 *  only: it neither refreshes nor checks the session with the PDS. */
export async function hasLinkedSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string,
	personDid: string
): Promise<boolean> {
	const kv = env?.OAUTH_SESSIONS;
	if (!kv) return false;
	return (await kv.get(groupSessionKey(groupDid, personDid), 'text')) !== null;
}

/** `personDid`'s session on `groupDid`, or null when there is none. Restored
 *  without a refresh: the session refreshes its own token on first use, so a
 *  lookup costs no round trip to the PDS. */
export async function linkedGroupSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string,
	personDid: string
): Promise<OAuthSession | null> {
	if (!(await hasLinkedSession(env, groupDid, personDid))) return null;
	return groupLinkClient(env, personDid).restore(groupDid as Did, { refresh: false });
}

/** An OAuth session on the group's account, approved by `person`. */
export interface LinkedGroupCredential {
	kind: 'linked';
	/** Who approved it, and whose roles it writes within. */
	person: string;
	session: Pick<OAuthSession, 'did' | 'handle'>;
}

export type GroupCredential = LinkedGroupCredential;

/** `personDid`'s credential to write as `groupDid`, or null when they have not
 *  linked one. A session that cannot be restored is an error, not a null: they
 *  linked it, so a silent "not linked" would hide a broken session. */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string,
	personDid: string
): Promise<GroupCredential | null> {
	const session = await linkedGroupSession(env, groupDid, personDid);
	return session ? { kind: 'linked', person: personDid, session } : null;
}

/** `personDid` holds no session on the group, so this app cannot write as the
 *  group for them. Only they can fix it, by linking from the group page. */
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

/** `personDid`'s credential, for a write as the group. Throws GroupCredentialError
 *  when they have not linked one, which only they can fix. */
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

/** Which credential served a write as the group: one line per write, never the
 *  token. Reads are not logged: there are many, and the log is about who wrote. */
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

/** The authed transport for one group account: a typed `Client` and the raw `handle`
 *  it is built on. `expectDid` is checked against the session, so a session stored
 *  under the wrong group fails loudly. `handle` is exported because
 *  `com.atproto.space.*` and `com.atproto.simplespace.*` are not in this app's
 *  generated lexicon set. */
export async function groupClient(
	cred: GroupCredential,
	expectDid: string
): Promise<GroupTransport> {
	return linkedClient(cred, expectDid);
}

/** The linked session refreshes its own token and retries once on a rejected one. */
function linkedClient(cred: LinkedGroupCredential, expectDid: string): GroupTransport {
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

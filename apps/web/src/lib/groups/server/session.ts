// Writing as a group: the one credential this app keeps for a group, and the
// one seam every request as the group goes through (`groupClient`).
//
// The credential is the group's linked session: an OAuth session on the group's
// own account, which its owner grants by signing in as the group and authorizing
// this app. This app stores no password for a group account. The creator holds
// its login, and a group nobody has linked cannot be written as. The one other
// credential is the session `createAccount` returns, which the create flow uses
// to set the new group up inside that one request and never stores.
//
// Linked sessions live in their own store, under `group:session:` in the sign-in
// sessions namespace. A sign-in session is keyed by DID too, so sharing that store
// would let a sign-in as the group overwrite the linked session with one that
// lacks the group's scope, and a link would leave a session a `did` cookie could
// restore.
//
// Every request as the group goes through `groupClient`. The human's OAuth
// session would author under the human's DID, and a repo write needs repo === the
// authenticated DID. A linked session manages its own tokens. The minted session
// is used well inside its token's lifetime, so it is sent as it is and never
// renewed.
import { Client } from '@atcute/client';
import { scope, type OAuthClient, type OAuthSession } from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { createOAuthClientFor } from '$lib/atproto/server/oauth';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';

/** The parts of the platform env a group session reads: the sessions namespace,
 *  and for restoring a link, the OAuth client's settings. */
export type CredentialStoreEnv = Partial<App.Platform['env']>;

export const GROUP_SESSION_PREFIX = 'group:session:';

/** What the group's session may do, and nothing else: its public-repo records
 *  (the declaration and public group events), its own spaces and their records,
 *  and image uploads. `authority=self` is the group's own spaces, resolved to
 *  its DID when the token is issued. The type is `*` because the PDS resolves
 *  every type a scope names, and the group.opensocial lexicons do not resolve
 *  yet (memory spaces-oauth-scopes-alpha). Proved on the alpha PDS by the
 *  2026-10-01 group-account OAuth probe, except the `repo:` and `blob:` parts. */
export const GROUP_SESSION_SCOPES: readonly string[] = [
	scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
	'space:*?authority=self&manage=create&manage=update&manage=delete',
	'space:*?authority=self&collection=*',
	scope.blob({ accept: ['image/*'] })
];

/** The scope a link asks for. */
export const GROUP_SESSION_SCOPE = ['atproto', ...GROUP_SESSION_SCOPES].join(' ');

/** The client that links groups and restores their sessions. */
export function groupLinkClient(env: CredentialStoreEnv | undefined): OAuthClient {
	// The client reads the OAuth settings, which a deployment that links groups has.
	return createOAuthClientFor(
		env as App.Platform['env'] | undefined,
		GROUP_SESSION_SCOPES,
		GROUP_SESSION_PREFIX
	);
}

/** Whether `groupDid` has a linked session stored. A read of the store only:
 *  it neither refreshes nor checks the session with the PDS. */
export async function hasLinkedSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string
): Promise<boolean> {
	const kv = env?.OAUTH_SESSIONS;
	if (!kv) return false;
	return (await kv.get(GROUP_SESSION_PREFIX + groupDid, 'text')) !== null;
}

/** The group's linked session, or null when there is none. Restored without a
 *  refresh: the session refreshes its own token on first use, so a lookup costs
 *  no round trip to the PDS. */
export async function linkedGroupSession(
	env: CredentialStoreEnv | undefined,
	groupDid: string
): Promise<OAuthSession | null> {
	if (!(await hasLinkedSession(env, groupDid))) return null;
	return groupLinkClient(env).restore(groupDid as Did, { refresh: false });
}

/** An OAuth session on the group's account, granted by its owner. */
export interface LinkedGroupCredential {
	kind: 'linked';
	session: Pick<OAuthSession, 'did' | 'handle'>;
}

/** The session `createAccount` returned. It lives only for the create request that
 *  minted the account, so it is never refreshed or stored. */
export interface MintSessionCredential {
	kind: 'mint-session';
	service: string;
	did: string;
	accessJwt: string;
}

export type GroupCredential = LinkedGroupCredential | MintSessionCredential;

/** The credential to write as `groupDid`, or null when its owner has not linked
 *  it. A linked session that cannot be restored is an error, not a null: the
 *  owner linked it, so a silent "not linked" would hide a broken session. */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string
): Promise<GroupCredential | null> {
	const session = await linkedGroupSession(env, groupDid);
	return session ? { kind: 'linked', session } : null;
}

/** The group's owner has not linked its account, so this app cannot author as the
 *  group. Only the owner can fix it, by linking from the group page. */
export class GroupCredentialError extends Error {
	constructor(readonly groupDid: string) {
		super(`${groupDid} is not linked: its owner has not authorized this app to write as it`);
		this.name = 'GroupCredentialError';
	}
}

/** The group's credential, for a write. Throws GroupCredentialError when the
 *  group is not linked, which only its owner can fix. */
export async function requireGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string
): Promise<GroupCredential> {
	const cred = await resolveGroupCredential(env, groupDid);
	if (!cred) throw new GroupCredentialError(groupDid);
	return cred;
}

type GroupTransport = {
	client: Client;
	handle: (pathname: string, init: RequestInit) => Promise<Response>;
	did: string;
};

/** Which credential served a write as the group: one line per write, never the
 *  token. Reads are not logged; there are many, and custody is about writes. */
function reportWrite(
	via: GroupCredential['kind'],
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
	return cred.kind === 'linked'
		? linkedClient(cred, expectDid)
		: mintSessionClient(cred, expectDid);
}

/** The linked session refreshes its own token and retries once on a rejected one. */
function linkedClient(cred: LinkedGroupCredential, expectDid: string): GroupTransport {
	const { session } = cred;
	if (session.did !== expectDid) {
		throw new Error(`linked group session authenticates ${session.did}, not ${expectDid}`);
	}
	const handle = async (pathname: string, init: RequestInit): Promise<Response> => {
		const res = await session.handle(pathname, init);
		reportWrite('linked', expectDid, pathname, init, res.status);
		return res;
	};
	return { client: new Client({ handler: handle }), handle, did: session.did };
}

/** The minted account's own session. A rejected token is the PDS's answer, not a
 *  reason to retry: there is no password to log in again with. */
function mintSessionClient(cred: MintSessionCredential, expectDid: string): GroupTransport {
	if (cred.did !== expectDid) {
		throw new Error(`minted group session authenticates ${cred.did}, not ${expectDid}`);
	}
	const handle = async (pathname: string, init: RequestInit): Promise<Response> => {
		const headers = new Headers(init.headers);
		headers.set('authorization', `Bearer ${cred.accessJwt}`);
		const res = await fetch(new URL(pathname, cred.service), { ...init, headers });
		reportWrite('mint-session', expectDid, pathname, init, res.status);
		return res;
	};
	return { client: new Client({ handler: handle }), handle, did: cred.did };
}

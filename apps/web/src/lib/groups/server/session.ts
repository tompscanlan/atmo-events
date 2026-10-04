// The session every write as a group goes through. The human's OAuth session would
// author under the human's DID, and a repo write needs repo === the authenticated DID.
// A linked session (./linked-session.ts) manages its own tokens. For the app password,
// @atcute/client has no credential manager, so the lifecycle is here: createSession,
// a cache per isolate, refreshSession on expiry, one retry.
import { Client } from '@atcute/client';
import type { AppPasswordCredential, GroupCredential, LinkedGroupCredential } from './credentials';

interface CachedSession {
	did: string;
	accessJwt: string;
	refreshJwt: string;
}

// Keyed by `service|identifier`.
const sessions = new Map<string, CachedSession>();

// Renewals in flight. One expired token can fail several reads at once, and they must
// share one renewal: a refresh token is single-use, and a password login is rate-limited.
const renewing = new Map<string, Promise<CachedSession>>();

const AUTH_ERRORS: Record<string, true> = {
	ExpiredToken: true,
	InvalidToken: true,
	AuthMissing: true,
	AuthenticationRequired: true
};

async function postJson(service: string, nsid: string, body: unknown) {
	return fetch(new URL(`/xrpc/${nsid}`, service), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
}

async function createSession(cred: AppPasswordCredential): Promise<CachedSession> {
	const res = await postJson(cred.service, 'com.atproto.server.createSession', {
		identifier: cred.identifier,
		password: cred.password
	});
	if (!res.ok) {
		// The identifier is safe to name in an error; the password never is.
		throw new Error(
			`group credential for ${cred.identifier} was rejected by ${cred.service} (${res.status})`
		);
	}
	const data = (await res.json()) as { did: string; accessJwt: string; refreshJwt: string };
	return { did: data.did, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt };
}

async function refresh(
	cred: AppPasswordCredential,
	session: CachedSession
): Promise<CachedSession> {
	// No body, not even `{}`: a PDS refuses one on refreshSession, which would turn
	// every renewal into a password login.
	const res = await fetch(new URL('/xrpc/com.atproto.server.refreshSession', cred.service), {
		method: 'POST',
		headers: { authorization: `Bearer ${session.refreshJwt}` }
	});
	if (!res.ok) return createSession(cred);
	const data = (await res.json()) as { did: string; accessJwt: string; refreshJwt: string };
	return { did: data.did, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt };
}

async function errorName(res: Response): Promise<string | null> {
	try {
		const clone = res.clone();
		const body = (await clone.json()) as { error?: string };
		return typeof body.error === 'string' ? body.error : null;
	} catch {
		return null;
	}
}

const TOKEN_ERRORS: Record<string, true> = { ExpiredToken: true, InvalidToken: true };

/** One renewal per key at a time. A call whose token was already replaced takes the
 *  new session. */
function renew(
	key: string,
	cred: AppPasswordCredential,
	stale: CachedSession
): Promise<CachedSession> {
	const cached = sessions.get(key);
	if (cached && cached.accessJwt !== stale.accessJwt) return Promise.resolve(cached);
	let pending = renewing.get(key);
	if (!pending) {
		pending = refresh(cred, stale).finally(() => renewing.delete(key));
		renewing.set(key, pending);
	}
	return pending;
}

/** A PDS answers an expired or invalid token with 400 (`ExpiredToken`, `InvalidToken`)
 *  and keeps 401 for a missing one, so a 400 counts only by its error name. */
async function tokenRejected(res: Response): Promise<boolean> {
	if (res.status === 401) {
		const name = await errorName(res);
		return !name || AUTH_ERRORS[name] === true;
	}
	if (res.status === 400) {
		const name = await errorName(res);
		return name !== null && TOKEN_ERRORS[name] === true;
	}
	return false;
}

type GroupTransport = {
	client: Client;
	handle: (pathname: string, init: RequestInit) => Promise<Response>;
	did: string;
};

/** Which credential served a write as the group: one line per write, never the
 *  token. Reads are not logged; there are many, and custody is about writes. */
function reportWrite(
	via: 'linked' | 'app-password',
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
 *  it is built on. A linked session is used when the group has one, else the app
 *  password (`resolveGroupCredential` decides). `expectDid` is checked against the
 *  session, so a credential stored under the wrong group fails loudly. `handle` is
 *  exported because `com.atproto.space.*` and `com.atproto.simplespace.*` are not in
 *  this app's generated lexicon set. */
export async function groupClient(
	cred: GroupCredential,
	expectDid: string
): Promise<GroupTransport> {
	return cred.kind === 'linked' ? linkedClient(cred, expectDid) : passwordClient(cred, expectDid);
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

/** A rejected token is retried once after a refresh, which is safe because every
 *  body sent here is re-readable. */
async function passwordClient(
	cred: AppPasswordCredential,
	expectDid: string
): Promise<GroupTransport> {
	const key = `${cred.service}|${cred.identifier}`;
	let session = sessions.get(key);
	if (!session) {
		session = await createSession(cred);
		sessions.set(key, session);
	}
	if (session.did !== expectDid) {
		sessions.delete(key);
		throw new Error(
			`group credential for ${cred.identifier} authenticates ${session.did}, not ${expectDid}`
		);
	}

	const handle = async (pathname: string, init: RequestInit): Promise<Response> => {
		const current = sessions.get(key) ?? session!;
		const send = (token: string) => {
			const headers = new Headers(init.headers);
			headers.set('authorization', `Bearer ${token}`);
			return fetch(new URL(pathname, cred.service), { ...init, headers });
		};

		const first = await send(current.accessJwt);
		if (!(await tokenRejected(first))) {
			reportWrite('app-password', expectDid, pathname, init, first.status);
			return first;
		}

		const renewed = await renew(key, cred, current);
		if (renewed.did !== expectDid) {
			sessions.delete(key);
			throw new Error(`refreshed group session authenticates ${renewed.did}, not ${expectDid}`);
		}
		sessions.set(key, renewed);
		const retried = await send(renewed.accessJwt);
		reportWrite('app-password', expectDid, pathname, init, retried.status);
		return retried;
	};

	return { client: new Client({ handler: handle }), handle, did: session.did };
}

/** For tests. An isolate's cache dies with the isolate. */
export function clearGroupSessions() {
	sessions.clear();
	renewing.clear();
}

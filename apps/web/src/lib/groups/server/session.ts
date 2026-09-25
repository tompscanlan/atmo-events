// An authenticated @atcute/client bound to a group's custodial account.
//
// The human's OAuth session (locals.client) is the wrong credential for a group
// write: it would author the record under the human's DID. This module opens a
// password session for the group account instead, so `repo` can be the group
// DID and the PDS will accept it (a repo write requires repo === the
// authenticated DID).
//
// @atcute/client ships no credential manager, so the session is managed here:
// createSession, a cache per isolate, refreshSession on expiry, one retry. That
// is the whole lifecycle a server-side custodial account needs.
import { Client } from '@atcute/client';
import type { GroupCredential } from './credentials';

interface CachedSession {
	did: string;
	accessJwt: string;
	refreshJwt: string;
}

// Keyed by `service|identifier`, inserted at runtime as groups are used, so a
// Map rather than a static table.
const sessions = new Map<string, CachedSession>();

const AUTH_ERRORS: Record<string, true> = {
	ExpiredToken: true,
	InvalidToken: true,
	AuthMissing: true,
	AuthenticationRequired: true
};

async function postJson(service: string, nsid: string, body: unknown, token?: string) {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	return fetch(new URL(`/xrpc/${nsid}`, service), {
		method: 'POST',
		headers,
		body: JSON.stringify(body ?? {})
	});
}

async function createSession(cred: GroupCredential): Promise<CachedSession> {
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

async function refresh(cred: GroupCredential, session: CachedSession): Promise<CachedSession> {
	const res = await postJson(
		cred.service,
		'com.atproto.server.refreshSession',
		{},
		session.refreshJwt
	);
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

/** The authed transport for one group account: a typed `Client`, plus the raw
 *  `handle` the Client is built on.
 *
 *  `expectDid` is the DID the caller believes it is writing as. It is checked
 *  against the session the PDS actually returns, so a credential stored under
 *  the wrong group fails loudly instead of quietly writing that group's records
 *  as some other account.
 *
 *  WHY `handle` IS EXPORTED. `client.post` is typed against the registered
 *  lexicon set (`XRPCProcedures`), which covers `com.atproto.repo.*` but not
 *  `com.atproto.space.*` or `com.atproto.simplespace.*`. Those come from the
 *  permissioned-data (Spaces) PDS and are not generated into this app, so
 *  callers send them through the raw handler, as
 *  `apps/api/scripts/spaces-e2e.mjs` does. Once the space lexicons are
 *  published and generated, these calls can move onto the typed client.
 *
 *  A 401 is retried once with a refreshed token. The bodies sent here are JSON
 *  strings and Blobs, both re-readable; a streaming body would not be, and
 *  nothing here sends one. */
export async function groupClient(
	cred: GroupCredential,
	expectDid: string
): Promise<{
	client: Client;
	handle: (pathname: string, init: RequestInit) => Promise<Response>;
	did: string;
}> {
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
		if (first.status !== 401) return first;
		const name = await errorName(first);
		if (name && !AUTH_ERRORS[name]) return first;

		const renewed = await refresh(cred, current);
		if (renewed.did !== expectDid) {
			sessions.delete(key);
			throw new Error(`refreshed group session authenticates ${renewed.did}, not ${expectDid}`);
		}
		sessions.set(key, renewed);
		return send(renewed.accessJwt);
	};

	return { client: new Client({ handler: handle }), handle, did: session.did };
}

/** Drops cached sessions. Only the tests need this; a Worker isolate's cache
 *  dies with the isolate. */
export function clearGroupSessions() {
	sessions.clear();
}

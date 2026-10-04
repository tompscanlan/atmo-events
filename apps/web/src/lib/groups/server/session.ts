// The session every write as a group goes through. The human's OAuth session would
// author under the human's DID, and a repo write needs repo === the authenticated DID.
// A linked session (./linked-session.ts) manages its own tokens. The session
// `createAccount` returns is used only inside the create request that minted the
// account, well inside its token's lifetime, so it is sent as it is and never renewed.
import { Client } from '@atcute/client';
import type { GroupCredential, LinkedGroupCredential, MintSessionCredential } from './credentials';

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

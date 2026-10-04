// Where the app gets the right to write as a group: the session the group's owner
// linked (./linked-session.ts). This app stores no password for a group account.
// The creator holds its login, and a group nobody has linked cannot be written as.
//
// The one other credential is the session `createAccount` returns. The create flow
// uses it to set the new group up, inside that one request, and never stores it.

import type { OAuthSession } from '@atcute/oauth-node-client';
import { linkedGroupSession } from './linked-session';

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

export interface CredentialStoreEnv {
	/** Where linked sessions are kept, under their own prefix. */
	OAUTH_SESSIONS?: KVNamespace;
}

/** The credential to write as `groupDid`, or null when its owner has not linked
 *  it. A linked session that cannot be restored is an error, not a null: the
 *  owner linked it, so a silent "not linked" would hide a broken session. */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	groupDid: string
): Promise<GroupCredential | null> {
	const session = await linkedGroupSession(env as App.Platform['env'], groupDid);
	return session ? { kind: 'linked', session } : null;
}

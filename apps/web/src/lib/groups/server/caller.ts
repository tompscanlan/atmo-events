// The caller's own session at their PDS, which every read of a group's spaces goes out on.
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { SpaceHolder } from './space-credential';

export interface CallerSession extends SpaceHolder {
	scope: string;
}

/** Read without a token refresh: the granted scope does not change on one. */
export async function callerSession(session: OAuthSession | null): Promise<CallerSession | null> {
	if (!session) return null;
	try {
		const { scope } = await session.getTokenInfo(false);
		return { did: session.did, scope, handle: (pathname, init) => session.handle(pathname, init) };
	} catch (e) {
		console.warn('[groups] the caller’s session scope could not be read:', e);
		return null;
	}
}

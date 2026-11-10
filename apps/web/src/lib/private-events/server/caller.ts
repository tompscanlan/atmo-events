// The caller's own session at their PDS, which every read and write of a private event goes out on.
import type { OAuthSession } from '@atcute/oauth-node-client';
import { waitUntil } from 'cloudflare:workers';
import { withinTimeLimit, withTimeLimit } from '#lib/spaces/server/other-servers.js';
import type { SpaceHolder } from '#lib/spaces/server/space-credential.js';
import { errorKind } from '#lib/spaces/server/xrpc.js';

export interface CallerSession extends SpaceHolder {
	did: string;
	scope: string;
}

/** Read without a token refresh: the granted scope does not change on one. The read can still wait
 *  on the session store, or on a refresh another call has under way, so it has the time limit too,
 *  as does each call through the session, since a page waits on both as on anyone else's server. */
export async function callerSession(session: OAuthSession | null): Promise<CallerSession | null> {
	if (!session) return null;
	try {
		const { scope } = await withinTimeLimit(session.getTokenInfo(false));
		return {
			did: session.did,
			scope,
			handle: (pathname, init) => withinLimit((limited) => session.handle(pathname, limited), init)
		};
	} catch (e) {
		console.warn(`[private-events] the session scope could not be read: ${errorKind(e)}`);
		return null;
	}
}

/** Each call through the session has the same time limit as a call to anyone else's server, since
 *  a page waits on both. The page stops waiting then, but the call goes on: a token refresh inside
 *  it ignores the signal, since a refresh token works once and the new tokens have to be kept. */
function withinLimit(
	call: (init: RequestInit) => Promise<Response>,
	init: RequestInit
): Promise<Response> {
	const limited = withTimeLimit(init);
	const signal = limited.signal as AbortSignal;
	const running = call(limited);
	waitUntil(running.catch(() => {}));
	return new Promise((resolve, reject) => {
		const stop = () => reject(signal.reason);
		if (signal.aborted) return stop();
		signal.addEventListener('abort', stop, { once: true });
		running.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
	});
}

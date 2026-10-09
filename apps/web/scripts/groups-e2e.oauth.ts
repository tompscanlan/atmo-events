// The e2e's stand-in for the OAuth client, aliased over `$lib/atproto/server/oauth`
// in its Vite build (groups-e2e.mjs).
//
// The app writes as a group only through the session its owner linked. A real link
// needs this deployment's confidential client key and a consent at the group's PDS,
// and a local run has neither. So `restore` here returns a session that logs in with
// the password the run's create set and sends each request with that token. Everything
// around it is the app's own: the store lookup (`linkedGroupSession`), the seam's
// linked branch (`groupClient`) and every transport. What it cannot show is the scope
// a real link carries; a walk through a deployed site with a linked group covers that.

/** The Worker binding the driver sets for the stand-in. */
interface StandInEnv {
	E2E_GROUP_SERVICE?: string;
}

/** The group's login, set by the worker's link op. Never logged. */
let standInLogin: { identifier: string; password: string } | null = null;

/** Sets the login the stand-in session uses, as the owner's link would grant it. */
export function setStandInLogin(identifier: string, password: string): void {
	standInLogin = { identifier, password };
	login = null;
}

interface Login {
	did: string;
	accessJwt: string;
}

// One login per isolate. A run is far shorter than the token's lifetime.
let login: Promise<Login> | null = null;

/** Every request the app sent through the group's linked session, in order, as
 *  its path and query. A worker op hands the driver the slice it caused, so a
 *  "no read" is a count of requests sent, not an inference from a result. The
 *  login is not in it: it is the stand-in's own, and goes out on `fetch`. */
export const standInCalls: string[] = [];

async function logIn(service: string, identifier: string, password: string): Promise<Login> {
	const res = await fetch(new URL('/xrpc/com.atproto.server.createSession', service), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier, password })
	});
	if (!res.ok) {
		// The identifier is safe to name; the password never is.
		throw new Error(`stand-in login for ${identifier} was refused (${res.status})`);
	}
	const { did, accessJwt } = (await res.json()) as Login;
	return { did, accessJwt };
}

/** Replaces the app's: `restore` is all `linkedGroupSession` asks of it. */
export function createOAuthClientWithSessions(env: StandInEnv | undefined) {
	const service = env?.E2E_GROUP_SERVICE;
	return {
		restore: async () => {
			if (!service || !standInLogin) {
				throw new Error('the stand-in linked session has no login: link the group first');
			}
			const { identifier, password } = standInLogin;
			login ??= logIn(service, identifier, password).catch((e) => {
				login = null;
				throw e;
			});
			const { did, accessJwt } = await login;
			return {
				did,
				handle: (pathname: string, init?: RequestInit) => {
					standInCalls.push(pathname);
					const headers = new Headers(init?.headers);
					headers.set('authorization', `Bearer ${accessJwt}`);
					return fetch(new URL(pathname, service), { ...init, headers });
				}
			};
		}
	};
}

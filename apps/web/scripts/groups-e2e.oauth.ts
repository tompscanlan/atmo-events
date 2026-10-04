// The e2e's stand-in for the OAuth client, aliased over `$lib/atproto/server/oauth`
// in its Vite build (groups-e2e.mjs).
//
// The app writes as a group only through the session its owner linked. A real link
// needs this deployment's confidential client key and a consent at the group's PDS,
// and a local run has neither. So `restore` here returns a session that logs in with
// the fixture group's password and sends each request with that token. Everything
// around it is the app's own: the store lookup (`linkedGroupSession`), the seam's
// linked branch (`groupClient`) and every transport. What it cannot show is the scope
// a real link carries; a walk through a deployed site with a linked group covers that.

/** The Worker bindings the driver sets for the stand-in. Never logged. */
interface StandInEnv {
	E2E_GROUP_SERVICE?: string;
	E2E_GROUP_IDENTIFIER?: string;
	E2E_GROUP_PASSWORD?: string;
}

interface Login {
	did: string;
	accessJwt: string;
}

// One login per isolate. A run is far shorter than the token's lifetime.
let login: Promise<Login> | null = null;

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
export function createOAuthClientFor(env: StandInEnv | undefined) {
	const service = env?.E2E_GROUP_SERVICE;
	const identifier = env?.E2E_GROUP_IDENTIFIER;
	const password = env?.E2E_GROUP_PASSWORD;
	return {
		restore: async () => {
			if (!service || !identifier || !password) {
				throw new Error('the stand-in linked session has no E2E_GROUP_* bindings');
			}
			login ??= logIn(service, identifier, password).catch((e) => {
				login = null;
				throw e;
			});
			const { did, accessJwt } = await login;
			return {
				did,
				handle: (pathname: string, init?: RequestInit) => {
					const headers = new Headers(init?.headers);
					headers.set('authorization', `Bearer ${accessJwt}`);
					return fetch(new URL(pathname, service), { ...init, headers });
				}
			};
		}
	};
}

// The e2e's stand-in for the OAuth client, aliased over `$lib/atproto/server/oauth`
// in its Vite build (groups-e2e.mjs).
//
// The app writes as a group only through a group session someone with write roles
// linked, one per person and group. A real link needs this deployment's confidential
// client key and a consent at the group's PDS, and a local run has neither. So
// `restore` here returns a session that logs in with the password the run's create
// set and sends each request with that token, recording whose stored session the app
// restored. Everything around it is the app's own: the per-person store lookup
// (`linkedGroupSession`), the seam's linked branch (`groupClient`) and every
// transport. What it cannot show is the scope a real link carries, or a host cutting
// a session to its person's roles; the stand-in's only way in is the group's own
// login, so every person's session here holds the whole account.
//
// Against a real group host (E2E_BRIDGE set) there is no group login: each person
// linked a real group session from the host, which the driver holds, and `restore`
// sends each request to the driver's bridge for that group and person
// (groups-e2e.signin.mjs). What is recorded is the same either way.

/** The Worker binding the driver sets for the stand-in. */
interface StandInEnv {
	E2E_GROUP_SERVICE?: string;
	/** A host run: the driver's bridge to each person's real sessions. */
	E2E_BRIDGE?: string;
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

/** Every request the app sent through a group session, in order, as its path
 *  and query. A worker op hands the driver the slice it caused, so a "no read"
 *  is a count of requests sent, not an inference from a result. The login is not
 *  in it: it is the stand-in's own, and goes out on `fetch`. */
export const standInCalls: string[] = [];

/** Each write among `standInCalls`, as `<method> <collection or read policy>`:
 *  what the path alone does not say. Kept apart, so the paths stay as they were
 *  sent. (Spec: SC-208, the order of a visibility change.) */
export const standInWrites: string[] = [];

/** Whose stored session sent each of `standInWrites`, by the same index. */
export const standInWriters: string[] = [];

function writeLabel(pathname: string, body: unknown): string | null {
	const nsid = pathname.split('?')[0].replace(/^\/xrpc\//, '');
	if (!/^com\.atproto\.(repo|space|simplespace)\./.test(nsid) || typeof body !== 'string')
		return null;
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(body) as Record<string, unknown>;
	} catch {
		return null;
	}
	const policy = (parsed.readPolicy as { $type?: string } | undefined)?.$type?.split('#')[1];
	const what = typeof parsed.collection === 'string' ? parsed.collection : policy;
	return what ? `${nsid.replace('com.atproto.', '')} ${what}` : null;
}

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

/** Replaces the app's: `restore` is all `linkedGroupSession` asks of it. The
 *  app builds one client per person over that person's store, so what the store
 *  holds under the group says whose session this is. */
export function createOAuthClientWithSessions(
	env: StandInEnv | undefined,
	_scopes: unknown,
	sessions: { get(did: string): Promise<{ person?: string } | undefined> }
) {
	const service = env?.E2E_GROUP_SERVICE;
	const bridge = env?.E2E_BRIDGE;
	return {
		restore: async (groupDid: string) => {
			const person = (await sessions.get(groupDid))?.person;
			if (!person) throw new Error(`the stand-in holds no session on ${groupDid} in this store`);
			const recorded = (send: (pathname: string, init?: RequestInit) => Promise<Response>) => ({
				did: groupDid,
				handle: (pathname: string, init?: RequestInit) => {
					standInCalls.push(pathname);
					const written = writeLabel(pathname, init?.body);
					if (written) {
						standInWrites.push(written);
						standInWriters.push(person);
					}
					return send(pathname, init);
				}
			});
			if (bridge) {
				const at = `/group/${encodeURIComponent(groupDid)}/${encodeURIComponent(person)}`;
				return recorded((pathname, init) => fetch(new URL(`${at}${pathname}`, bridge), init));
			}
			if (!service || !standInLogin) {
				throw new Error('the stand-in linked session has no login: link the group first');
			}
			const { identifier, password } = standInLogin;
			login ??= logIn(service, identifier, password).catch((e) => {
				login = null;
				throw e;
			});
			const { did, accessJwt } = await login;
			if (did !== groupDid) throw new Error(`the stand-in login is ${did}, not ${groupDid}`);
			return recorded((pathname, init) => {
				const headers = new Headers(init?.headers);
				headers.set('authorization', `Bearer ${accessJwt}`);
				return fetch(new URL(pathname, service), { ...init, headers });
			});
		}
	};
}

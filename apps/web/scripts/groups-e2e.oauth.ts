// The e2e's replacement for the OAuth client, aliased over `$lib/atproto/server/oauth`
// in its Vite build (groups-e2e.mjs).
//
// The app writes as a group only through a group session someone with write roles
// linked, one per person and group. A real link needs this deployment's confidential
// client key, which a local run does not have. So each person linked a real group
// session from the group host through the driver's own loopback OAuth client
// (groups-e2e.signin.mjs), the driver holds it, and `restore` here sends each
// request to the driver's bridge for that group and person, recording whose stored
// session the app restored. Everything around it is the app's own: the per-person
// store lookup (`linkedGroupSession`), the seam's linked branch (`groupClient`) and
// every transport.

/** The Worker binding the driver sets. */
interface BridgeEnv {
	/** The driver's bridge to each person's real sessions. */
	E2E_BRIDGE?: string;
}

/** Every request the app sent through a group session, in order, as its path
 *  and query. A worker op hands the driver the slice it caused, so a "no read"
 *  is a count of requests sent, not an inference from a result. */
export const groupSessionCalls: string[] = [];

/** Each write among `groupSessionCalls`, as `<method> <collection or read policy>`:
 *  what the path alone does not say. Kept apart, so the paths stay as they were
 *  sent. (Spec: SC-208, the order of a visibility change.) */
export const groupSessionWrites: string[] = [];

/** Whose stored session sent each of `groupSessionWrites`, by the same index. */
export const groupSessionWriters: string[] = [];

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

/** Replaces the app's: `restore` is all `linkedGroupSession` asks of it. The
 *  app builds one client per person over that person's store, so what the store
 *  holds under the group says whose session this is. */
export function createOAuthClientWithSessions(
	env: BridgeEnv | undefined,
	_scopes: unknown,
	sessions: { get(did: string): Promise<{ person?: string } | undefined> }
) {
	const bridge = env?.E2E_BRIDGE;
	return {
		restore: async (groupDid: string) => {
			const person = (await sessions.get(groupDid))?.person;
			if (!person)
				throw new Error(`the e2e's OAuth client holds no session on ${groupDid} in this store`);
			if (!bridge)
				throw new Error("the e2e's OAuth client has no bridge to the driver: set E2E_BRIDGE");
			const recorded = (send: (pathname: string, init?: RequestInit) => Promise<Response>) => ({
				did: groupDid,
				handle: (pathname: string, init?: RequestInit) => {
					groupSessionCalls.push(pathname);
					const written = writeLabel(pathname, init?.body);
					if (written) {
						groupSessionWrites.push(written);
						groupSessionWriters.push(person);
					}
					return send(pathname, init);
				}
			});
			const at = `/group/${encodeURIComponent(groupDid)}/${encodeURIComponent(person)}`;
			return recorded((pathname, init) => fetch(new URL(`${at}${pathname}`, bridge), init));
		}
	};
}

/** The app's sign-in client, which a run never uses: each person signs in through the
 *  driver's own loopback client (groups-e2e.signin.mjs). */
export function createOAuthClient(): never {
	throw new Error("the e2e signs people in through the driver's own client");
}

export function servesClientMetadata(): boolean {
	return false;
}

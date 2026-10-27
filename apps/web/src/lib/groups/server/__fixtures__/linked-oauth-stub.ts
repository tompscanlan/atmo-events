// The OAuth client half of ./linked-group.ts, kept apart so a `vi.mock` factory
// can import it without importing the module it replaces: this file imports
// nothing from the app.

/** The token a fixture session sends. Never a real one. */
export const LINKED_TEST_TOKEN = 'linked-session-token';

/** The header a fixture session sends naming whose session it is, so a test can
 *  tell which person's session served a request. Never sent by the app. */
export const SESSION_PERSON_HEADER = 'x-fixture-session-person';

/** Which PDS each linked fixture group's session talks to, by DID. */
export const linkedServices = new Map<string, string>();

/** Who holds a session on each linked group, by group DID. A group linked with
 *  no people named is held by anyone who asks, for tests that do not care whose
 *  session a write goes out on. */
export const linkedHolders = new Map<string, ReadonlySet<string> | 'anyone'>();

/** Whether `personDid` holds a session on the linked group `groupDid`. */
export function holdsSession(groupDid: string, personDid: string): boolean {
	if (!linkedServices.has(groupDid)) return false;
	const holders = linkedHolders.get(groupDid) ?? 'anyone';
	return holders === 'anyone' || holders.has(personDid);
}

/** What the fixture stores for a held session: only whose it is. */
export function storedSession(personDid: string): string {
	return JSON.stringify({ person: personDid });
}

/** The session `person`'s link would have stored for `did`: it sends each
 *  request to the group's PDS with a bearer token, where the test's stubbed
 *  `fetch` answers. */
export function stubSession(did: string, service: string, person = 'unnamed') {
	return {
		did: did as `did:${string}:${string}`,
		handle: async (pathname: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set('authorization', `Bearer ${LINKED_TEST_TOKEN}`);
			headers.set(SESSION_PERSON_HEADER, person);
			return fetch(new URL(pathname, service), { ...init, headers });
		}
	};
}

/** Replaces `createOAuthClientWithSessions`: a client whose `restore` finds the
 *  fixture's session in the person's store, and fails for one no test linked, as
 *  a real store miss would. */
export const linkedOAuthStub = {
	createOAuthClientWithSessions: (
		_env: unknown,
		_scopes: unknown,
		sessions: { get(did: string): Promise<{ person?: string } | undefined> }
	) => ({
		restore: async (did: string) => {
			const service = linkedServices.get(did);
			const stored = await sessions.get(did);
			if (!service || !stored?.person) throw new Error(`no linked session for ${did}`);
			return stubSession(did, service, stored.person);
		}
	})
};

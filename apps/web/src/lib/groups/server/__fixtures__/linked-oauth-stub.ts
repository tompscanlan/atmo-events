// The OAuth client half of ./linked-group.ts, kept apart so a `vi.mock` factory
// can import it without importing the module it replaces: this file imports
// nothing from the app.

/** The token a fixture session sends. Never a real one. */
export const LINKED_TEST_TOKEN = 'linked-session-token';

/** Which PDS each linked fixture group's session talks to, by DID. */
export const linkedServices = new Map<string, string>();

/** The session a link would have stored for `did`: it sends each request to the
 *  group's PDS with a bearer token, where the test's stubbed `fetch` answers. */
export function stubSession(did: string, service: string) {
	return {
		did: did as `did:${string}:${string}`,
		handle: async (pathname: string, init?: RequestInit) => {
			const headers = new Headers(init?.headers);
			headers.set('authorization', `Bearer ${LINKED_TEST_TOKEN}`);
			return fetch(new URL(pathname, service), { ...init, headers });
		}
	};
}

/** Replaces `createOAuthClientWithSessions`: a client whose `restore` finds the fixture's
 *  session, and fails for a group no test linked, as a real store miss would. */
export const linkedOAuthStub = {
	createOAuthClientWithSessions: () => ({
		restore: async (did: string) => {
			const service = linkedServices.get(did);
			if (!service) throw new Error(`no linked session for ${did}`);
			return stubSession(did, service);
		}
	})
};

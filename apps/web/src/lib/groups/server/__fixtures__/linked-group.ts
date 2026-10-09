// A group whose owner has linked its account: the one way this app writes as a
// group outside the create request.
//
// Restoring a real linked session needs the group's PDS and this deployment's
// confidential OAuth client, so a test stubs the client and keeps the rest real:
// the store lookup (`linkedGroupSession`), the seam (`groupClient`) and every
// transport. The stubbed client's `restore` hands back a session that sends each
// request to the group's PDS with a bearer token, which is where a test's stubbed
// `fetch` (./stub-pds.ts) answers it.
//
// A test file opts in with a partial mock, since `vi.mock` is hoisted per file:
//
//   vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
//   	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
//   	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
//   }));

import { linkedServices, stubSession } from './linked-oauth-stub';

import { GROUP_SESSION_PREFIX, type LinkedGroupCredential } from '../session';
export { LINKED_TEST_TOKEN } from './linked-oauth-stub';

/** The stub PDS's address, which every fixture group lives on unless a test says. */
export const STUB_PDS_SERVICE = 'https://pds.stub.test';

/** An in-memory stand-in for the sessions namespace. Only reads are needed: the
 *  app never writes a linked session outside the link callback. */
function sessionsKv(dids: readonly string[]): KVNamespace {
	const keys = new Set(dids.map((did) => GROUP_SESSION_PREFIX + did));
	return {
		get: async (key: string) => (keys.has(key) ? '{}' : null)
	} as unknown as KVNamespace;
}

/** Links each group in `dids` and returns the env that finds their sessions.
 *  Call it again in each test's setup: the links last until `unlinkAllGroups`. */
export function linkGroups(
	dids: readonly string[],
	service: string = STUB_PDS_SERVICE
): { OAUTH_SESSIONS: KVNamespace } {
	for (const did of dids) linkedServices.set(did, service);
	return { OAUTH_SESSIONS: sessionsKv([...linkedServices.keys()]) };
}

/** For an `afterEach`: no link outlives the test that made it. */
export function unlinkAllGroups(): void {
	linkedServices.clear();
}

/** The credential `resolveGroupCredential` returns for a linked fixture group,
 *  for a test that drives a transport directly. */
export function linkedCredential(
	did: string,
	service: string = STUB_PDS_SERVICE
): LinkedGroupCredential {
	linkedServices.set(did, service);
	return { kind: 'linked', session: stubSession(did, service) };
}

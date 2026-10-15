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

import {
	holdsSession,
	linkedHolders,
	linkedServices,
	storedSession,
	stubSession
} from './linked-oauth-stub';

import { parseGroupSessionKey, type LinkedGroupCredential } from '../session';
export { LINKED_TEST_TOKEN, SESSION_PERSON_HEADER } from './linked-oauth-stub';

/** The stub PDS's address, which every fixture group lives on unless a test says. */
export const STUB_PDS_SERVICE = 'https://pds.stub.test';

/** An in-memory stand-in for the sessions namespace, read live. Only reads are
 *  needed: the app never writes a group session outside the link callback. */
const sessionsKv = {
	get: async (key: string) => {
		const named = parseGroupSessionKey(key);
		return named && holdsSession(named.groupDid, named.personDid)
			? storedSession(named.personDid)
			: null;
	}
} as unknown as KVNamespace;

/** Links each group in `dids` and returns the env that finds their sessions.
 *  `people` hold one each; left out, anyone does. Call it again in each test's
 *  setup: the links last until `unlinkAllGroups`. */
export function linkGroups(
	dids: readonly string[],
	service: string = STUB_PDS_SERVICE,
	people?: readonly string[]
): { OAUTH_SESSIONS: KVNamespace } {
	for (const did of dids) {
		linkedServices.set(did, service);
		linkedHolders.set(did, people ? new Set(people) : 'anyone');
	}
	return { OAUTH_SESSIONS: sessionsKv };
}

/** For an `afterEach`: no link outlives the test that made it. */
export function unlinkAllGroups(): void {
	linkedServices.clear();
	linkedHolders.clear();
}

/** The credential `resolveGroupCredential` returns for a linked fixture group,
 *  for a test that drives a transport directly. */
export function linkedCredential(
	did: string,
	service: string = STUB_PDS_SERVICE,
	person = 'did:plc:fixtureperson00000000000'
): LinkedGroupCredential {
	linkedServices.set(did, service);
	return { kind: 'linked', person, session: stubSession(did, service, person) };
}

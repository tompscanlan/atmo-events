// Where the right to write as a group comes from: only the session its owner
// linked. The store is read for real; the OAuth client that restores a session
// is the fixture's (./__fixtures__/linked-group.ts).
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import { resolveGroupCredential } from './credentials';
import { GROUP_SESSION_PREFIX } from './linked-session';

const DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';

/** A sessions namespace holding exactly `keys`. */
function kv(keys: string[]): KVNamespace {
	return {
		get: async (key: string) => (keys.includes(key) ? '{}' : null)
	} as unknown as KVNamespace;
}

afterEach(() => unlinkAllGroups());

describe('resolveGroupCredential', () => {
	it('is the linked session when the store holds one for the group', async () => {
		const env = linkGroups([DID]);

		const cred = await resolveGroupCredential(env, DID);

		expect(cred?.kind).toBe('linked');
		expect(cred?.kind === 'linked' && cred.session.did).toBe(DID);
	});

	// Nothing else stands in: no stored password, no deployment-wide account.
	it('is null for a group whose owner has not linked it', async () => {
		await expect(resolveGroupCredential(linkGroups([OTHER]), DID)).resolves.toBeNull();
	});

	it('is null on a deployment with no sessions namespace', async () => {
		await expect(resolveGroupCredential({}, DID)).resolves.toBeNull();
	});

	// A sign-in as the group is stored under the bare DID. It lacks the group's
	// scope, so it must not count as a link. The fixture's client throws for a
	// group no test linked, so a restore attempt would fail this case too.
	it('does not take a sign-in session under the bare DID for a link', async () => {
		await expect(resolveGroupCredential({ OAUTH_SESSIONS: kv([DID]) }, DID)).resolves.toBeNull();
	});

	// The owner linked it, so a silent "not linked" would hide a broken session.
	it('fails, rather than answering null, when a stored link cannot be restored', async () => {
		const env = { OAUTH_SESSIONS: kv([GROUP_SESSION_PREFIX + DID]) };

		await expect(resolveGroupCredential(env, DID)).rejects.toThrow(/no linked session/);
	});
});

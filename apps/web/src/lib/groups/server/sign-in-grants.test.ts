// What a sign-in asks the PDS for. A member of a group asks for that group's
// grant on top of the base scope. Everyone else asks for the base scope alone,
// and the groups lookup is never what stops a sign-in. The fallback when the PDS
// refuses a grant is member-grants' (firstAcceptedScope in its tests).
//
// The OAuth client is a stand-in that records each authorize; the groups table
// is the real SQL.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scopes } from '$lib/atproto/settings';

const authorized: { grants: readonly string[]; scope: string; prompt?: string }[] = [];
const oauth: {
	servesMetadata: boolean;
	resolve: (handle: string) => Promise<string>;
} = { servesMetadata: true, resolve: async () => ALICE };

vi.mock('$lib/atproto/server/oauth', () => ({
	servesClientMetadata: () => oauth.servesMetadata,
	resolveActorDid: (handle: string) => oauth.resolve(handle),
	createOAuthClient: (_env: unknown, grants: readonly string[] = []) => ({
		authorize: async (options: { scope: string; prompt?: string }) => {
			authorized.push({ grants, scope: options.scope, prompt: options.prompt });
			return { url: new URL('https://pds.test/oauth/authorize') };
		}
	})
}));

import { authorizeSignIn } from './sign-in-grants';
import { memberGrant, METADATA_CACHE_MS } from './member-grants';

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';

import { createGroup } from './db/groups';
import { addMember } from './db/roster';
const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';
const KONA = 'did:plc:kona0000000000000000000a';
const BASE = scopes.join(' ');

let harness: SqliteD1;

beforeEach(async () => {
	harness = sqliteD1();
	authorized.length = 0;
	oauth.servesMetadata = true;
	oauth.resolve = async () => ALICE;
	const kona = await createGroup(harness.db, { groupDid: KONA, ownerDid: OWNER, name: 'Kona' });
	await addMember(harness.db, kona.id, ALICE, 'member');
	// Older than the metadata cache, so the grant set has no middle step.
	await harness.db
		.prepare(`UPDATE groups SET created_at = ?`)
		.bind(Date.now() - METADATA_CACHE_MS - 1)
		.run();
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
});

const signIn = (handle: string | undefined, prompt?: 'create') =>
	authorizeSignIn({ DB: harness.db } as App.Platform['env'], handle, {
		target: { type: 'account', identifier: 'alice.test' },
		prompt
	});

describe('authorizeSignIn', () => {
	it('asks for the grant of each group the member is in', async () => {
		await signIn('alice.test');
		expect(authorized).toEqual([
			{ grants: [memberGrant(KONA)], scope: `${BASE} ${memberGrant(KONA)}`, prompt: undefined }
		]);
	});

	it.each([
		['a signup, which has no handle yet', () => signIn(undefined, 'create')],
		[
			'a loopback client, which cannot declare more scope',
			() => ((oauth.servesMetadata = false), signIn('alice.test'))
		],
		[
			'a handle that does not resolve here',
			() => (
				(oauth.resolve = async () => {
					throw new Error('no such handle');
				}),
				signIn('alice.test')
			)
		]
	])('asks for the base scope alone on %s', async (_case, run) => {
		await run();
		expect(authorized.map((a) => a.scope)).toEqual([BASE]);
	});
});

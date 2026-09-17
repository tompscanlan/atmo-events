// THE ORDERING OF GROUP CREATION (SC-008), against a stub PDS and the real
// schema.
//
// `mint.test.ts` already covers how a PDS refusal maps onto a `MintFailure`,
// and `credentials.test.ts` covers the encrypted round-trip. What neither can
// see is the SEQUENCE — mint -> store -> INSERT -> provision — because a
// `did:plc` is permanent, so the only acceptable outcome of a name collision is
// that nothing durable exists afterwards. These cases assert the artifacts, not
// the call: no group row, no credential row, no space.
//
// The stub stands in for `GROUP_PDS_SERVICE`. It records every XRPC call in
// order, so "did not happen" is assertable rather than assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { clearGroupSessions } from './server/session';
import { runCreateGroup, type CreateGroupData, type CreateGroupEnv } from './create-group';

const OWNER = 'did:plc:owner';
const MINTED_DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';
const SERVICE = 'https://pds.stub.test';
/** 32 bytes, base64 — `canStoreMintedCredentials` accepts nothing shorter. */
const KEY = btoa('0123456789abcdef0123456789abcdef');

let harness: SqliteD1;
let env: CreateGroupEnv;

function data(overrides: Partial<CreateGroupData> = {}): CreateGroupData {
	return {
		name: 'Kona Trail Runners',
		slug: 'kona',
		visibility: 'public',
		status: 'published',
		requireApproval: true,
		...overrides
	};
}

/** Answers the whole mint + provision chain, including the PLC read that
 *  proves the owner's rotation key landed first. `account` replaces the
 *  `createAccount` response, which is where a name collision lands.
 *
 *  The PLC half echoes back the `recoveryKey` it was sent, which is exactly
 *  what the real directory does — so a mint that forgot to send one, or sent it
 *  second, still fails here. */
function stubPds(overrides: { account?: () => Response } = {}) {
	const calls: string[] = [];
	let recoveryKey: string | undefined;
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = String(input);

		if (url.startsWith('https://plc.directory/')) {
			calls.push('plc.directory/data');
			return Response.json({ rotationKeys: [recoveryKey, 'did:key:zPdsOwnedKey'] });
		}

		const nsid = url.split('/xrpc/')[1] ?? url;
		calls.push(nsid);
		if (nsid.startsWith('com.atproto.server.createAccount')) {
			({ recoveryKey } = JSON.parse(String(init?.body)) as { recoveryKey?: string });
			return (
				overrides.account?.() ??
				Response.json({
					did: MINTED_DID,
					// Deliberately NOT the submitted slug: the PDS is what adjudicates
					// the name, so the row must be written from THIS value (FR-001a).
					handle: 'konatrail.group.stub.test',
					accessJwt: 'master-jwt'
				})
			);
		}
		if (nsid.startsWith('com.atproto.server.createAppPassword')) {
			return Response.json({ password: 'app-pass-1234' });
		}
		if (nsid.startsWith('com.atproto.server.createSession')) {
			return Response.json({
				did: MINTED_DID,
				handle: 'konatrail.group.stub.test',
				accessJwt: 'group-jwt',
				refreshJwt: 'group-refresh'
			});
		}
		if (nsid.startsWith('com.atproto.simplespace.createSpace')) {
			const body = JSON.parse(String(init?.body)) as { type: string; skey: string };
			return Response.json({ uri: `at://${MINTED_DID}/space/${body.type}/${body.skey}` });
		}
		throw new Error(`unexpected call to ${url}`);
	});
	return calls;
}

async function rows(table: 'groups' | 'group_credentials') {
	const result = await harness.db.prepare(`SELECT * FROM ${table}`).all();
	return result.results ?? [];
}

beforeEach(() => {
	harness = sqliteD1();
	clearGroupSessions();
	env = {
		DB: harness.db,
		GROUP_PDS_SERVICE: SERVICE,
		GROUP_HANDLE_DOMAIN: 'group.stub.test',
		GROUP_PDS_INVITE_CODE: 'stub-aaaaa-bbbbb',
		GROUP_ACCOUNT_EMAIL: 'groups@openmeet.net',
		GROUP_CREDENTIAL_KEY: KEY
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	harness.close();
});

describe('a name the PDS refuses', () => {
	// SC-008. The handle registration IS the reservation, so this is the whole
	// collision path: it must cost nothing that cannot be taken back.
	it('leaves no DID, no group row, no credential and no space', async () => {
		const calls = stubPds({
			account: () =>
				Response.json(
					{ error: 'HandleNotAvailable', message: 'Handle already taken' },
					{ status: 400 }
				)
		});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result).toEqual({ ok: false, error: '“kona” is already taken. Choose another URL name.' });
		expect(await rows('groups')).toEqual([]);
		expect(await rows('group_credentials')).toEqual([]);
		// Nothing past the mint ran: no session, and above all no space, which
		// would otherwise be an artifact under a DID we never recorded.
		expect(calls).toEqual(['com.atproto.server.createAccount']);
	});
});

describe('refusing before the irreversible step', () => {
	// A deployment that cannot keep the credential must not mint: the app
	// password is shown exactly once, so minting first strands the account.
	it('makes no PDS call at all when GROUP_CREDENTIAL_KEY is missing', async () => {
		const calls = stubPds();
		delete env.GROUP_CREDENTIAL_KEY;

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});

	// Our slug rules are wider than the PDS's handle rules. A label the PDS
	// would reject has to fail on the field the user can edit — before a mint,
	// not as a PDS error after one.
	it('makes no PDS call for a slug the PDS would reject', async () => {
		const calls = stubPds();

		const result = await runCreateGroup(env, OWNER, data({ slug: 'kona-trail-runners-club' }));

		expect(result.ok).toBe(false);
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});
});

describe('a successful create', () => {
	// The PLC read sits between the mint and the first durable write: if the
	// owner's key did not land at index 0 the group is portable in name only, and
	// FR-001g says find that out before telling anyone the group exists.
	it('mints, verifies the rotation key, then stores, inserts and provisions', async () => {
		const calls = stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			'com.atproto.server.createAccount',
			'com.atproto.server.createAppPassword',
			'plc.directory/data',
			'com.atproto.server.createSession',
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace'
		]);
	});

	// FR-001a: the slug is the minted handle's leaf, never the submitted field,
	// because the PDS's handle registry is what adjudicated the name.
	it('writes the group from the minted handle and keys the credential on the minted DID', async () => {
		stubPds();

		const result = await runCreateGroup(env, OWNER, data({ slug: 'kona' }));

		expect(result).toMatchObject({ ok: true, groupSlug: 'konatrail' });
		const [group] = (await rows('groups')) as { slug: string; group_did: string }[];
		expect(group.slug).toBe('konatrail');
		expect(group.group_did).toBe(MINTED_DID);
		const [cred] = (await rows('group_credentials')) as { group_did: string; secret: string }[];
		expect(cred.group_did).toBe(MINTED_DID);
		// Never in the clear, even though the row is ours.
		expect(cred.secret).not.toContain('app-pass-1234');
	});

	// The rotation key is the owner's only way to move the group off our PDS,
	// and it is returned exactly once — which is why the route cannot redirect.
	it('returns the owner rotation key and records both space URIs', async () => {
		stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok && result.recoveryKey).toBeTruthy();
		const [group] = (await rows('groups')) as {
			about_space_uri: string;
			members_space_uri: string;
		}[];
		expect(group.about_space_uri).toBe(`at://${MINTED_DID}/space/net.openmeet.space.about/self`);
		expect(group.members_space_uri).toBe(
			`at://${MINTED_DID}/space/net.openmeet.space.members/self`
		);
	});
});

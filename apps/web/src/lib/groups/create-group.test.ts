// THE ORDERING OF GROUP CREATION, against a stub PDS and the real schema: a
// create that fails must leave no durable artifact behind. (Spec: SC-008.)
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
	/** Every record written into a space, in order — the create path's records. */
	const spaceWrites: {
		space: string;
		collection: string;
		rkey: string;
		record: Record<string, unknown>;
	}[] = [];
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
					// the name, so the row must be written from THIS value — the leaf
					// label of the handle actually registered. (Spec: FR-001a.)
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
		// The group's public face, written through the gate right after
		// provisioning: `profile` at `self`, plus one record per rule.
		if (
			nsid.startsWith('com.atproto.space.putRecord') ||
			nsid.startsWith('com.atproto.space.createRecord')
		) {
			const body = JSON.parse(String(init?.body)) as {
				space: string;
				collection: string;
				rkey: string;
				record: Record<string, unknown>;
			};
			spaceWrites.push(body);
			return Response.json({
				uri: `${body.space}/${MINTED_DID}/${body.collection}/${body.rkey}`,
				cid: 'bafycreate'
			});
		}
		throw new Error(`unexpected call to ${url}`);
	});
	return { calls, spaceWrites };
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
	// The handle registration IS the reservation, so this is the whole collision
	// path: it must cost nothing that cannot be taken back. (Spec: SC-008.)
	it('leaves no DID, no group row, no credential and no space', async () => {
		const { calls } = stubPds({
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
		const { calls } = stubPds();
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
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data({ slug: 'kona-trail-runners-club' }));

		expect(result.ok).toBe(false);
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});
});

describe('a successful create', () => {
	// The PLC read sits between the mint and the first durable write: if the
	// owner's key did not land at index 0 the group is portable in name only, so
	// that has to be found out before anyone is told the group exists.
	// (Spec: FR-001g.)
	it('mints, verifies the rotation key, then stores, inserts, provisions and writes its records', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		expect(calls).toEqual([
			'com.atproto.server.createAccount',
			'com.atproto.server.createAppPassword',
			'plc.directory/data',
			'com.atproto.server.createSession',
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace',
			// The records land LAST, after both spaces exist — there is nowhere to
			// put them before that. Profile first (the about space), then the
			// members space: its access record, the authz config (three roles and
			// the two binding records), and last the owner's membership, because a
			// membership grants a role nothing has declared until the config is
			// there. (Spec: FR-004, FR-005, FR-006.)
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord'
		]);
	});

	// A group whose about space is empty can be read by its DID and nothing
	// else, which is the portability bug this iteration exists to close.
	it('writes the profile into the about space, as the group, at self', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data({ locationName: 'Kailua-Kona' }));

		const profile = spaceWrites.filter(
			(write) => write.collection === 'net.openmeet.group.profile'
		);
		expect(profile).toHaveLength(1);
		expect(profile[0]).toMatchObject({
			space: `at://${MINTED_DID}/space/net.openmeet.space.about/self`,
			collection: 'net.openmeet.group.profile',
			rkey: 'self'
		});
		expect(profile[0].record).toMatchObject({
			$type: 'net.openmeet.group.profile',
			displayName: 'Kona Trail Runners',
			// Derived from the row, not taken from the form. (Spec: FR-004b.)
			joinPolicy: 'approval',
			// The declared location extension, name only. (Spec: FR-004a.)
			location: { name: 'Kailua-Kona' }
		});
	});

	// THE ROSTER IS RECORDS FROM THE FIRST MEMBER ONWARDS. A group whose members
	// space holds no membership record has a roster only this deployment's
	// database knows about, which is the other half of the portability bug —
	// and the owner is the one membership every new group has. (Spec: FR-006.)
	it('writes the access record and the owner’s membership into the members space', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const members = `at://${MINTED_DID}/space/net.openmeet.space.members/self`;
		const access = spaceWrites.find((w) => w.collection === 'net.openmeet.group.access');
		const membership = spaceWrites.find((w) => w.collection === 'net.openmeet.group.membership');

		expect(access).toMatchObject({ space: members, rkey: 'self' });
		expect(access?.record).toMatchObject({
			$type: 'net.openmeet.group.access',
			roles: ['owner', 'admin', 'member']
		});
		// Keyed by the member DID, which is what makes "is this DID a member" a
		// single getRecord for any app that can read the space.
		expect(membership).toMatchObject({ space: members, rkey: OWNER });
		expect(membership?.record).toMatchObject({
			$type: 'net.openmeet.group.membership',
			subject: OWNER,
			roles: ['owner']
		});
	});

	// THE AUTHZ CONFIG IS RECORDS TOO, and this is the whole point of T013: a
	// peer app reading the members space can answer "what may an admin do here"
	// without our database. The community record publishes the STANDARD's
	// identifiers — a peer app can only check what it can name — while the
	// modality record publishes ours, the standard defining none.
	// (Spec: FR-005, FR-005a.)
	it('writes one role record per seeded role and both binding records', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const members = `at://${MINTED_DID}/space/net.openmeet.space.members/self`;
		const roles = spaceWrites.filter((w) => w.collection === 'net.openmeet.group.role');
		expect(roles.map((w) => w.rkey)).toEqual(['owner', 'admin', 'member']);
		expect(roles.every((w) => w.space === members)).toBe(true);
		// Keyed by the role id, and the record repeats it: a role lifted out of
		// its key is otherwise anonymous.
		expect(roles[1].record).toMatchObject({ $type: 'net.openmeet.group.role', id: 'admin' });

		const permissions = spaceWrites.find(
			(w) => w.collection === 'net.openmeet.group.permissions'
		);
		expect(permissions).toMatchObject({ space: members, rkey: 'self' });
		expect(permissions?.record).toMatchObject({
			$type: 'net.openmeet.group.permissions',
			bindings: [
				{ role: 'owner', actions: ['community.configure', 'admit', 'eject', 'role.assign'] },
				{ role: 'admin', actions: ['community.configure', 'admit', 'eject', 'role.assign'] },
				// Bound to nothing is a different statement from not bound, and the
				// seeded member holds nothing at either altitude.
				{ role: 'member', actions: [] }
			]
		});

		const eventPermissions = spaceWrites.find(
			(w) => w.collection === 'net.openmeet.group.eventPermissions'
		);
		expect(eventPermissions).toMatchObject({ space: members, rkey: 'self' });
		expect(eventPermissions?.record).toMatchObject({
			$type: 'net.openmeet.group.eventPermissions',
			bindings: [
				{ role: 'owner', actions: ['manageEvents', 'createEvent'] },
				{ role: 'admin', actions: ['manageEvents', 'createEvent'] },
				{ role: 'member', actions: [] }
			]
		});
		// No community action rides in the modality record and no modality action
		// rides in the community one — that is the two-altitude split, and it is
		// what a single flattened record would lose.
		expect(JSON.stringify(permissions?.record)).not.toContain('createEvent');
		expect(JSON.stringify(eventPermissions?.record)).not.toContain('admit');
	});

	// Rules have no column at all, so these records are the only copy — and one
	// record per rule is what makes a rule citable. (Spec: FR-004c.)
	it('writes one rule record per non-empty line', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data({ rules: 'Be kind\n\n  No spam  \n' }));

		const rules = spaceWrites.filter((write) => write.collection === 'net.openmeet.group.rule');
		expect(rules.map((write) => write.record.text)).toEqual(['Be kind', 'No spam']);
		expect(rules.map((write) => write.record.order)).toEqual([0, 1]);
		// Distinct TIDs, so each rule has its own address.
		expect(new Set(rules.map((write) => write.rkey)).size).toBe(2);
	});

	// The slug is the minted handle's leaf, never the submitted field, because the
	// PDS's handle registry is what adjudicated the name. (Spec: FR-001a.)
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

// The order of group creation, tested against a stub PDS and the real schema:
// a create that fails must leave nothing durable behind.
//
// `mint.test.ts` covers how a PDS refusal maps to a `MintFailure`, and
// `credentials.test.ts` covers the encrypted round trip. These tests cover the
// sequence (rehearse -> mint -> store -> INSERT -> provision). A `did:plc` is
// permanent, so after a name collision nothing durable may exist. The cases
// check what exists afterwards (group row, credential row, space), not only
// which calls were made.
//
// The stub stands in for `GROUP_PDS_SERVICE`. It records every XRPC call in
// order, so "did not happen" can be asserted rather than assumed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { ensureGroupsSchema } from './server/schema';
import { clearGroupSessions } from './server/session';
import { runCreateGroup, type CreateGroupData, type CreateGroupEnv } from './create-group';

const OWNER = 'did:plc:owner';
const MINTED_DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';
const SERVICE = 'https://pds.stub.test';
/** 32 bytes, base64: `canStoreMintedCredentials` accepts nothing shorter. */
const KEY = btoa('0123456789abcdef0123456789abcdef');

let harness: SqliteD1;
let env: CreateGroupEnv;

function data(overrides: Partial<CreateGroupData> = {}): CreateGroupData {
	return {
		name: 'Kona Trail Runners',
		// The handle label to mint, which is not stored anywhere: the PDS's handle
		// registration is the group's only name reservation.
		label: 'kona',
		visibility: 'public',
		requireApproval: true,
		...overrides
	};
}

/** Answers the whole mint + provision chain, including the PLC read that
 *  proves the owner's rotation key landed first. `account` replaces the
 *  `createAccount` response, which is where a name collision lands.
 *
 *  The PLC half echoes back the `recoveryKey` it was sent, as the real
 *  directory does, so a mint that forgot to send one, or sent it second, still
 *  fails here. */
function stubPds(
	overrides: {
		account?: () => Response;
		/** Answers a call instead of the stub when it returns a Response: the way
		 *  a test fails one step after the mint. */
		fail?: (nsid: string, init?: RequestInit) => Response | undefined;
	} = {}
) {
	const calls: string[] = [];
	/** Every record written into a space, in order: the create path's records. */
	const spaceWrites: {
		space: string;
		collection: string;
		rkey: string;
		record: Record<string, unknown>;
	}[] = [];
	/** Every record written into the group's public repo: the declaration, and
	 *  nothing else this path writes. Kept apart from `spaceWrites` because the
	 *  container matters: a declaration written into a space would be invisible
	 *  to the anonymous readers it exists for. */
	const repoWrites: {
		repo: string;
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
		const failed = overrides.fail?.(nsid, init);
		if (failed) return failed;
		if (nsid.startsWith('com.atproto.server.createAccount')) {
			({ recoveryKey } = JSON.parse(String(init?.body)) as { recoveryKey?: string });
			return (
				overrides.account?.() ??
				Response.json({
					did: MINTED_DID,
					// Not the submitted label: the PDS decides the name, so the handle
					// a caller is told about must come from this value, never from the
					// field they typed.
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
		// Reads answer from the writes. The write gate resolves from the members
		// space's records, so a stub that could not read back what the create
		// just wrote would test a gate no deployment runs. A missing record is
		// the PDS's 400, which the reader maps to "absent".
		if (nsid.startsWith('com.atproto.space.getRecord')) {
			const q = new URL(url).searchParams;
			const hit = spaceWrites.findLast(
				(w) =>
					w.space === q.get('space') &&
					w.collection === q.get('collection') &&
					w.rkey === q.get('rkey')
			);
			if (!hit) return Response.json({ error: 'RecordNotFound' }, { status: 400 });
			return Response.json({
				uri: `${hit.space}/${MINTED_DID}/${hit.collection}/${hit.rkey}`,
				cid: 'bafycreate',
				value: hit.record
			});
		}
		if (nsid.startsWith('com.atproto.space.listRecords')) {
			const q = new URL(url).searchParams;
			const collection = q.get('collection');
			const records = spaceWrites
				.filter((w) => w.space === q.get('space') && (!collection || w.collection === collection))
				.map((w) => ({
					uri: `${w.space}/${MINTED_DID}/${w.collection}/${w.rkey}`,
					cid: 'bafycreate',
					value: w.record
				}));
			return Response.json({ records });
		}
		// The one record that does not go into a space: the declaration, which an
		// anonymous peer reads straight from the group's repo.
		if (
			nsid.startsWith('com.atproto.repo.putRecord') ||
			nsid.startsWith('com.atproto.repo.createRecord')
		) {
			const body = JSON.parse(String(init?.body)) as {
				repo: string;
				collection: string;
				rkey: string;
				record: Record<string, unknown>;
			};
			repoWrites.push(body);
			return Response.json({
				uri: `at://${body.repo}/${body.collection}/${body.rkey}`,
				cid: 'bafycreate'
			});
		}
		throw new Error(`unexpected call to ${url}`);
	});
	return { calls, spaceWrites, repoWrites };
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
		GROUP_ACCOUNT_EMAIL: 'groups@example.com',
		GROUP_CREDENTIAL_KEY: KEY
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	harness.close();
});

describe('a name the PDS refuses', () => {
	// The handle registration is the reservation, so this is the whole collision
	// path: it must cost nothing that cannot be taken back.
	it('leaves no DID, no group row, no credential and no space', async () => {
		const { calls } = stubPds({
			account: () =>
				Response.json(
					{ error: 'HandleNotAvailable', message: 'Handle already taken' },
					{ status: 400 }
				)
		});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		// The refusal names the label the caller typed, because that is the field
		// they can change: a collision is not a deployment fault.
		expect(!result.ok && result.error).toContain('kona');
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

	// The label field accepts more than the PDS's handle rules do. A label the
	// PDS would reject has to fail on the field the user can edit, before a
	// mint, not as a PDS error after one.
	it('makes no PDS call for a label the PDS would reject', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data({ label: 'kona-trail-runners-club' }));

		expect(result.ok).toBe(false);
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});

	// Plain form input that the schema refuses. A trigger in
	// migrations/0001_groups.sql refuses this pair, but only at the INSERT,
	// which runs after the mint. Without the rehearsal the user would see the
	// rule and be left with a did:plc, a spent invite use and an orphan
	// credential row. The rehearsal puts the same refusal before the mint.
	it('mints nothing for a private group that does not require approval', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(
			env,
			OWNER,
			data({ visibility: 'private', requireApproval: false })
		);

		expect(result).toEqual({
			ok: false,
			error: 'A private group must require approval to join — invite members instead'
		});
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
		expect(await rows('group_credentials')).toEqual([]);
	});

	// Schema drift: a column the INSERT does not know about that refuses NULL.
	// The schema self-heal cannot repair this, so the create has to refuse it
	// before a did:plc exists, and say it is not the user's doing.
	it('mints nothing when the groups table has drifted to refuse the row', async () => {
		const { calls } = stubPds();
		harness.raw.exec('ALTER TABLE groups ADD COLUMN slug TEXT CHECK (slug IS NOT NULL)');

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain(
			'Group creation is unavailable on this deployment'
		);
		expect(!result.ok && result.error).toContain('slug');
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
		expect(await rows('group_credentials')).toEqual([]);
	});

	// Drift that raises nothing. Without the trigger that seeds the owner role,
	// the owner's membership INSERT…SELECT matches no role and writes zero rows,
	// so the create would succeed and produce a group nobody owns. Only a
	// rehearsal that checks what landed, rather than what did not fail, sees it.
	it('mints nothing when the row would land without its owner', async () => {
		const { calls } = stubPds();
		// Apply first, so a first-in-isolate self-heal cannot put the trigger back.
		await ensureGroupsSchema(harness.db);
		harness.raw.exec('DROP TRIGGER groups_seed_owner_role');

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('owner membership');
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});
});

describe('a successful create', () => {
	// The PLC read sits between the mint and the first durable write: if the
	// owner's key did not land at index 0 the group is portable in name only, so
	// that has to be found out before anyone is told the group exists.
	it('mints, verifies the rotation key, then stores, inserts, provisions and writes its records', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		// Writes only: the gate's own reads of the members space interleave with
		// them and are tested where the gate is tested.
		const writes = calls.filter((c) => !c.includes('.getRecord') && !c.includes('.listRecords'));
		expect(writes).toEqual([
			'com.atproto.server.createAccount',
			'com.atproto.server.createAppPassword',
			'plc.directory/data',
			'com.atproto.server.createSession',
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace',
			// The records land after both spaces exist, since there is nowhere to
			// put them before. Profile first (the about space), then the
			// declaration in the public repo, which points at the about space and
			// so cannot come before it. Then the members space: the access record,
			// the owner's membership, and last the authz config (three roles and
			// the two binding records). The membership comes first because once a
			// config exists the gate resolves from it, and an owner with no
			// membership record could not admit themselves. That order is asserted
			// on `spaceWrites` in the members-space test below.
			'com.atproto.space.putRecord',
			'com.atproto.repo.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord'
		]);
	});

	// The only record a stranger can read, and the only one in the public repo.
	it('declares a public group in its PUBLIC repo, pointing at the about space', async () => {
		const { repoWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		expect(repoWrites).toHaveLength(1);
		expect(repoWrites[0]).toMatchObject({
			repo: MINTED_DID,
			collection: 'net.openmeet.group.declaration',
			rkey: 'self'
		});
		expect(repoWrites[0].record).toMatchObject({
			$type: 'net.openmeet.group.declaration',
			aboutSpace: `at://${MINTED_DID}/space/net.openmeet.space.about/self`
		});
		// "Discovery only": no name, no avatar, nothing a stranger could
		// render without the credential the about space demands.
		expect(Object.keys(repoWrites[0].record).sort()).toEqual(['$type', 'aboutSpace', 'createdAt']);
	});

	// A private group writes nothing to its public repo. A create that wrote a
	// declaration anyway would announce a group that asked not to be announced.
	it('writes NO declaration for a private group, and no delete either', async () => {
		const { calls, repoWrites } = stubPds();

		const result = await runCreateGroup(env, OWNER, data({ visibility: 'private' }));

		expect(result.ok).toBe(true);
		expect(repoWrites).toEqual([]);
		// Not even a withdrawal: a repo minted four statements ago cannot be
		// holding a declaration to withdraw.
		expect(calls.filter((call) => call.startsWith('com.atproto.repo.'))).toEqual([]);
	});

	// Without a profile record the about space is empty, and a reader of the
	// group's records learns nothing but its DID.
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
			// Derived from the row, not taken from the form.
			joinPolicy: 'approval',
			// The declared location extension, name only.
			location: { name: 'Kailua-Kona' }
		});
	});

	// The roster is records from the first member. A group whose members space
	// holds no membership record has a roster only this deployment's database
	// knows about, and the owner is the one membership every new group has.
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
		// Before any authz record. Once a config exists the gate resolves from
		// records, so writing the config first would leave the owner unable to
		// admit themselves. This stub reads back its own writes, so it catches
		// that order.
		const firstAuthz = spaceWrites.findIndex((w) => w.collection === 'net.openmeet.group.role');
		expect(firstAuthz).toBeGreaterThan(-1);
		expect(spaceWrites.indexOf(membership!)).toBeLessThan(firstAuthz);
	});

	// The authz config is records too, so a peer app reading the members space
	// can answer "what may an admin do here" without our database. The community
	// record uses the standard's identifiers, because a peer app can only check
	// what it can name. The eventPermissions record uses ours, because the
	// standard defines none.
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

		const permissions = spaceWrites.find((w) => w.collection === 'net.openmeet.group.permissions');
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
		// No community action is in the eventPermissions record and no event
		// action is in the community one. A single flattened record would lose
		// that split.
		expect(JSON.stringify(permissions?.record)).not.toContain('createEvent');
		expect(JSON.stringify(eventPermissions?.record)).not.toContain('admit');
	});

	// Rules have no column at all, so these records are the only copy, and one
	// record per rule is what makes a rule citable.
	it('writes one rule record per non-empty line', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data({ rules: 'Be kind\n\n  No spam  \n' }));

		const rules = spaceWrites.filter((write) => write.collection === 'net.openmeet.group.rule');
		expect(rules.map((write) => write.record.text)).toEqual(['Be kind', 'No spam']);
		expect(rules.map((write) => write.record.order)).toEqual([0, 1]);
		// Distinct TIDs, so each rule has its own address.
		expect(new Set(rules.map((write) => write.rkey)).size).toBe(2);
	});

	// Everything is keyed on the minted DID. The only name returned is the
	// handle the PDS registered, never the submitted label, because the PDS
	// decided the name. No column stores another name, so a caller that wants to
	// address this group has the DID and a handle it must resolve.
	it('returns the minted DID and the registered handle, and keys every row on the DID', async () => {
		stubPds();

		const result = await runCreateGroup(env, OWNER, data({ label: 'kona' }));

		expect(result).toMatchObject({
			ok: true,
			groupDid: MINTED_DID,
			handle: 'konatrail.group.stub.test'
		});
		const [group] = (await rows('groups')) as { group_did: string }[];
		expect(group.group_did).toBe(MINTED_DID);
		const [cred] = (await rows('group_credentials')) as { group_did: string; secret: string }[];
		expect(cred.group_did).toBe(MINTED_DID);
		// Never in the clear, even though the row is ours.
		expect(cred.secret).not.toContain('app-pass-1234');
	});

	// A rebuild restores the group's creation date from its profile and the
	// owner's join date from their membership, so every record a create writes
	// must carry the row's own instant, not each writer's own, later "now".
	it('stamps every record it writes with the row’s creation time', async () => {
		const { spaceWrites, repoWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const [group] = (await rows('groups')) as { created_at: number }[];
		const stamped = [...spaceWrites, ...repoWrites].filter((w) => 'createdAt' in w.record);
		expect(stamped.map((w) => w.collection)).toEqual(
			expect.arrayContaining([
				'net.openmeet.group.profile',
				'net.openmeet.group.declaration',
				'net.openmeet.group.membership',
				'net.openmeet.group.access',
				'net.openmeet.group.role'
			])
		);
		expect(new Set(stamped.map((w) => w.record.createdAt))).toEqual(
			new Set([new Date(group.created_at).toISOString()])
		);
	});

	// The rotation key is the owner's only way to move the group off our PDS,
	// and it is returned exactly once, which is why the route cannot redirect.
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

// The owner's rotation key exists in one place: the response to this create.
// Once the did:plc is minted, every way the create can end has to carry it, or
// the owner is left holding a group (or a registered address) with no key of
// their own, and no route can show the key again.
describe('a create that fails after the mint', () => {
	const pdsDown = () => Response.json({ error: 'InternalServerError' }, { status: 500 });
	const writing = (collection: string) => (nsid: string, init?: RequestInit) =>
		(nsid.startsWith('com.atproto.space.putRecord') ||
			nsid.startsWith('com.atproto.space.createRecord')) &&
		(JSON.parse(String(init?.body)) as { collection: string }).collection === collection
			? pdsDown()
			: undefined;
	/** Fails the named table's INSERT for the minted DID only, so the rehearsal,
	 *  which inserts under its own DID, still passes. */
	const refuseInsert = async (table: 'groups' | 'group_credentials') => {
		await ensureGroupsSchema(harness.db);
		await harness.db
			.prepare(
				`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table}
				 WHEN NEW.group_did = '${MINTED_DID}'
				 BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END`
			)
			.run();
	};

	it.each([
		['storing the credential', () => refuseInsert('group_credentials'), {}],
		['inserting the group row', () => refuseInsert('groups'), {}],
		[
			'provisioning the spaces',
			async () => {},
			{
				fail: (nsid: string) =>
					nsid.startsWith('com.atproto.simplespace.createSpace') ? pdsDown() : undefined
			}
		],
		['writing the profile', async () => {}, { fail: writing('net.openmeet.group.profile') }],
		['writing the members space', async () => {}, { fail: writing('net.openmeet.group.access') }],
		[
			'issuing the app password',
			async () => {},
			{
				fail: (nsid: string) =>
					nsid.startsWith('com.atproto.server.createAppPassword') ? pdsDown() : undefined
			}
		]
	])('hands back the recovery key when %s fails', async (_step, arrange, stub) => {
		await arrange();
		const { calls } = stubPds(stub);

		const result = await runCreateGroup(env, OWNER, data());

		// The account exists: the failure is after the irreversible step.
		expect(calls).toContain('com.atproto.server.createAccount');
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({
			error: expect.stringContaining('konatrail.group.stub.test'),
			registered: {
				groupDid: MINTED_DID,
				handle: 'konatrail.group.stub.test',
				recoveryKey: expect.stringMatching(/^z/)
			}
		});
	});

	it('carries no key when the create fails before the mint', async () => {
		const { calls } = stubPds();
		const result = await runCreateGroup(env, OWNER, data({ label: 'x' }));
		expect(result.ok).toBe(false);
		expect(calls).not.toContain('com.atproto.server.createAccount');
		expect(result).not.toHaveProperty('registered');
	});
});

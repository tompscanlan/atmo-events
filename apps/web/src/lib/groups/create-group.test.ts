// The order of group creation, tested against a stub PDS and the real schema:
// a create that fails must leave nothing durable behind.
//
// `mint.test.ts` covers how a PDS refusal maps to a `MintFailure`. These tests
// cover the sequence (rehearse -> mint -> INSERT -> provision). A `did:plc` is
// permanent, so after a name collision nothing durable may exist. The cases
// check what exists afterwards (group row, space), not only which calls were
// made.
//
// The creator types the group account's email and password. Neither is stored
// or logged: the create writes through the session `createAccount` returned,
// and the group stays unlinked until its owner links it.
//
// The stub stands in for `GROUP_PDS_SERVICE`. It records every XRPC call in
// order, so "did not happen" can be asserted rather than assumed. It is the
// same fake host the settings save is tested against (./update-group.test.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRowWrite, sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { ensureGroupsSchema } from './server/schema';
import { stubPds as stubGroupPds, type StubPdsOptions } from './server/__fixtures__/stub-pds';
import { resolveGroupCredential } from './server/credentials';
import { GroupCredentialError, groupWriter } from './server/event-writer';
import { getGroupByDid } from './server/repo';
import { GROUP_PASSWORD_MIN_LENGTH } from './form-fields';
import { runCreateGroup, type CreateGroupData, type CreateGroupEnv } from './create-group';

const OWNER = 'did:plc:owner';
const MINTED_DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';
const SERVICE = 'https://pds.stub.test';
/** The login the creator types. Distinctive, so a test can look for it anywhere. */
const EMAIL = 'alice+kona@example.com';
const PASSWORD = 'correct-horse-battery-staple';

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
		email: EMAIL,
		password: PASSWORD,
		...overrides
	};
}

/** Answers the whole mint + provision chain (./server/__fixtures__/stub-pds.ts),
 *  as the minted group. `account` replaces the `createAccount` response, which
 *  is where a name collision lands. */
function stubPds(overrides: Pick<StubPdsOptions, 'account' | 'fail'> = {}) {
	return stubGroupPds({ did: MINTED_DID, handle: 'konatrail.group.stub.test', ...overrides });
}

async function rows(table: 'groups') {
	const result = await harness.db.prepare(`SELECT * FROM ${table}`).all();
	return result.results ?? [];
}

/** Every row of every table, as one string: what a D1 read or backup would yield. */
function everyStoredRow(): string {
	const tables = harness.raw
		.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
		.all() as { name: string }[];
	return JSON.stringify(
		tables.map(({ name }) => harness.raw.prepare(`SELECT * FROM "${name}"`).all())
	);
}

/** The sessions store of a deployment that links groups, holding no link. */
const noLinks = {
	OAUTH_SESSIONS: { get: async () => null } as unknown as KVNamespace
};

beforeEach(() => {
	harness = sqliteD1();
	env = {
		DB: harness.db,
		GROUP_PDS_SERVICE: SERVICE,
		GROUP_HANDLE_DOMAIN: 'group.stub.test',
		GROUP_PDS_INVITE_CODE: 'stub-aaaaa-bbbbb'
	};
});

afterEach(() => {
	vi.unstubAllGlobals();
	harness.close();
});

describe('a name the PDS refuses', () => {
	// The handle registration is the reservation, so this is the whole collision
	// path: it must cost nothing that cannot be taken back.
	it('leaves no DID, no group row and no space', async () => {
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
		// Nothing past the mint ran: no record, and above all no space, which
		// would otherwise be an artifact under a DID we never recorded.
		expect(calls).toEqual(['com.atproto.server.createAccount']);
	});
});

describe('a mint failure that is the deployment’s, not the user’s', () => {
	// A spent, wrong, disabled or taken-down invite code all come back from the
	// PDS as the same error, and the create path holds no admin credential to
	// ask which. So the form says only that it is not the user's fault, and this
	// log line is what an operator greps or alerts on.
	afterEach(() => {
		vi.restoreAllMocks();
	});

	const refuseInvite = () =>
		stubPds({
			account: () =>
				Response.json(
					{ error: 'InvalidInviteCode', message: 'Provided invite code not available' },
					{ status: 400 }
				)
		});

	it('logs one structured line naming the failure, and no secret', async () => {
		refuseInvite();
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(logged).toHaveBeenCalledTimes(1);
		expect(logged).toHaveBeenCalledWith({
			event: 'groups.mint-failed',
			failure: 'invite-unavailable',
			registered: false
		});
		const line = JSON.stringify(logged.mock.calls);
		expect(line).not.toContain(env.GROUP_PDS_INVITE_CODE);
		expect(line).not.toContain(EMAIL);
		expect(line).not.toContain(PASSWORD);
	});

	it('logs nothing for a name the user can change', async () => {
		stubPds({
			account: () =>
				Response.json(
					{ error: 'HandleNotAvailable', message: 'Handle already taken' },
					{ status: 400 }
				)
		});
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(logged).not.toHaveBeenCalled();
	});
});

// The creator's login is refused by the PDS at createAccount, before a did:plc
// exists. It is the creator's to fix, on the fields they typed, so the form says
// what to change and the operator's log stays quiet.
describe('a login the PDS refuses', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it.each([
		['Email already taken', 'you+mygroup@example.com'],
		['Password is too short', 'Choose a longer or different one']
	])(
		'returns the creator-facing message for “%s”, with no key and no log line',
		async (message, says) => {
			const { calls } = stubPds({
				account: () => Response.json({ error: 'InvalidRequest', message }, { status: 400 })
			});
			const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

			const result = await runCreateGroup(env, OWNER, data());

			expect(result.ok).toBe(false);
			expect(!result.ok && result.error).toContain(says);
			// Refused before the account existed, so there is no key to hand back.
			expect(result).not.toHaveProperty('registered');
			expect(logged).not.toHaveBeenCalled();
			expect(calls).toEqual(['com.atproto.server.createAccount']);
			expect(await rows('groups')).toEqual([]);
		}
	);
});

describe('refusing before the irreversible step', () => {
	// A partial configuration found after createAccount would already have
	// minted, so it has to refuse before any call.
	it('makes no PDS call at all when the group PDS is not fully configured', async () => {
		const { calls } = stubPds();
		delete env.GROUP_PDS_INVITE_CODE;

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain('GROUP_PDS_INVITE_CODE');
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});

	// A login the PDS cannot take would fail at createAccount anyway, but on
	// the PDS's wording. Checking its shape first puts the refusal on the
	// fields, with no PDS call.
	it.each([
		['an email with no @', { email: 'alice.example.com' }, 'email'],
		['an email with nothing after the @', { email: 'alice@' }, 'email'],
		['an email with a space', { email: 'alice smith@example.com' }, 'email'],
		[
			`a password under ${GROUP_PASSWORD_MIN_LENGTH} characters`,
			{ password: 'x'.repeat(GROUP_PASSWORD_MIN_LENGTH - 1) },
			`at least ${GROUP_PASSWORD_MIN_LENGTH} characters`
		]
	])('makes no PDS call for %s', async (_case, login, says) => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data(login));

		expect(result.ok).toBe(false);
		expect(!result.ok && result.error).toContain(says);
		expect(calls).toEqual([]);
		expect(await rows('groups')).toEqual([]);
	});

	it('takes a password of exactly the shortest length', async () => {
		stubPds();

		const result = await runCreateGroup(
			env,
			OWNER,
			data({ password: 'x'.repeat(GROUP_PASSWORD_MIN_LENGTH) })
		);

		expect(result.ok).toBe(true);
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

	// Plain form input the app refuses. Visibility is a choice sent to the host,
	// not a column, so no trigger can see this pair: the app refuses it, from
	// the form's two fields, before anything is written. That means before the
	// mint (a did:plc is permanent), and before the rehearsal's INSERT too, even
	// though that one is rolled back.
	it('create refuses a private group that is open to join before any write', async () => {
		const { calls } = stubPds();
		harness.statements.length = 0;

		const result = await runCreateGroup(
			env,
			OWNER,
			data({ visibility: 'private', requireApproval: false })
		);

		expect(result).toEqual({
			ok: false,
			error: 'A private group must require approval to join. Invite members instead.'
		});
		expect(calls).toEqual([]);
		expect(harness.statements.filter(isRowWrite)).toEqual([]);
		expect(await rows('groups')).toEqual([]);
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
	afterEach(() => {
		vi.restoreAllMocks();
	});

	// The PLC read sits between the mint and the first durable write: if the
	// owner's key did not land at index 0 the group is portable in name only, so
	// that has to be found out before anyone is told the group exists.
	it('mints, verifies the rotation key, then inserts, provisions and writes its records', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		// Writes only: the gate's own reads of the members space interleave with
		// them and are tested where the gate is tested.
		const writes = calls.filter((c) => !c.includes('.getRecord') && !c.includes('.listRecords'));
		expect(writes).toEqual([
			'com.atproto.server.createAccount',
			'plc.directory/data',
			'com.atproto.simplespace.createSpace',
			'com.atproto.simplespace.createSpace',
			// The records land after both spaces exist, since there is nowhere to
			// put them before. The about space first: the profile, then the access
			// record. Then the declaration in the public repo, which points at the
			// about space and so cannot come before it, and which a reader may
			// only find while the access record says public. Then the members
			// space: the access record, one index entry per space, the owner's
			// membership, and last the authz config (three roles and the two
			// binding records). The membership comes first because once a config
			// exists the gate resolves from it, and an owner with no membership
			// record could not admit themselves. That order is asserted on
			// `spaceWrites` in the members-space test below.
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.repo.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.createRecord',
			'com.atproto.space.createRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			'com.atproto.space.putRecord',
			// Last, the owner onto both member lists: a grant writes the
			// membership record first and the lists after it.
			'com.atproto.simplespace.putMember',
			'com.atproto.simplespace.putMember'
		]);
	});

	// The creator holds the login, so the create neither makes an app password
	// to keep nor logs in again: createAccount's session serves every write.
	it('makes no app password and no password login', async () => {
		const { calls } = stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		expect(calls).not.toContain('com.atproto.server.createAppPassword');
		expect(calls).not.toContain('com.atproto.server.createSession');
	});

	it('serves every write through the session the mint returned', async () => {
		stubPds();
		const logged: string[] = [];
		vi.spyOn(console, 'info').mockImplementation((line: string) => {
			logged.push(line);
		});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		const writes = logged.filter((line) => line.startsWith('[group-session]'));
		// Every kind of write a create makes: spaces, space records, the
		// declaration in the public repo, and the member lists.
		expect(writes.map((line) => line.split(' ')[2])).toEqual(
			expect.arrayContaining([
				'com.atproto.simplespace.createSpace',
				'com.atproto.space.putRecord',
				'com.atproto.repo.putRecord',
				'com.atproto.simplespace.putMember'
			])
		);
		for (const line of writes) {
			expect(line).toMatch(
				new RegExp(`^\\[group-session\\] ${MINTED_DID} \\S+ via mint-session: 200$`)
			);
		}
	});

	// The creator's login reaches the PDS and nowhere else: not a log line, not
	// a row. Reset mail goes to the creator, and this site keeps no address.
	it('puts the typed email and password in no console line and no stored row', async () => {
		const { requests } = stubPds();
		const lines: unknown[] = [];
		for (const level of ['error', 'warn', 'info', 'log'] as const) {
			vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
				lines.push(args);
			});
		}

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		// The PDS did get them, once, on createAccount.
		const sent = requests.filter((r) => JSON.stringify(r.body ?? {}).includes(PASSWORD));
		expect(sent.map((r) => r.nsid)).toEqual(['com.atproto.server.createAccount']);
		expect(sent[0].body).toMatchObject({ email: EMAIL, password: PASSWORD });

		const logged = JSON.stringify(lines);
		expect(logged).not.toContain(PASSWORD);
		expect(logged).not.toContain(EMAIL);
		const stored = everyStoredRow();
		expect(stored).not.toContain(PASSWORD);
		expect(stored).not.toContain(EMAIL);
		expect(JSON.stringify(result)).not.toContain(PASSWORD);
	});

	// The mint's session dies with the create request. After it, writing as the
	// group waits for the owner to link its account, and a write tried before
	// then is refused rather than served by anything this site kept.
	it('leaves the group unlinked, so a later write as the group is refused', async () => {
		stubPds();

		const result = await runCreateGroup(env, OWNER, data());

		expect(result.ok).toBe(true);
		expect(await resolveGroupCredential(noLinks, MINTED_DID)).toBeNull();
		const group = await getGroupByDid(harness.db, MINTED_DID);
		expect(group).not.toBeNull();
		await expect(groupWriter(noLinks, harness.db, group!)).rejects.toBeInstanceOf(
			GroupCredentialError
		);
	});

	// The only record a stranger can read, and the only one in the public repo.
	it('declares a public group in its PUBLIC repo, pointing at the meta space', async () => {
		const { repoWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		expect(repoWrites).toHaveLength(1);
		expect(repoWrites[0]).toMatchObject({
			repo: MINTED_DID,
			collection: 'group.opensocial.declaration',
			rkey: 'self'
		});
		expect(repoWrites[0].record).toMatchObject({
			$type: 'group.opensocial.declaration',
			meta: `at://${MINTED_DID}/space/group.opensocial.meta/self`
		});
		// "Discovery only": no name, no avatar, nothing a stranger could
		// render without the credential the meta space demands.
		expect(Object.keys(repoWrites[0].record).sort()).toEqual(['$type', 'createdAt', 'meta']);
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

		const profile = spaceWrites.filter((write) => write.collection === 'group.opensocial.profile');
		expect(profile).toHaveLength(1);
		expect(profile[0]).toMatchObject({
			space: `at://${MINTED_DID}/space/group.opensocial.meta/self`,
			collection: 'group.opensocial.profile',
			rkey: 'self'
		});
		expect(profile[0].record).toMatchObject({
			$type: 'group.opensocial.profile',
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

		const members = `at://${MINTED_DID}/space/group.opensocial.members/self`;
		const access = spaceWrites.find(
			(w) => w.collection === 'group.opensocial.access' && w.space === members
		);
		const membership = spaceWrites.find((w) => w.collection === 'group.opensocial.membership');

		expect(access).toMatchObject({ space: members, rkey: 'self' });
		expect(access?.record).toEqual({
			$type: 'group.opensocial.access',
			public: false,
			readRoles: ['owner', 'admin', 'member'],
			grants: []
		});
		// Keyed by the member DID, which is what makes "is this DID a member" a
		// single getRecord for any app that can read the space.
		expect(membership).toMatchObject({ space: members, rkey: OWNER });
		expect(membership?.record).toMatchObject({
			$type: 'group.opensocial.membership',
			member: OWNER,
			roles: ['owner']
		});
		// Before any authz record. Once a config exists the gate resolves from
		// records, so writing the config first would leave the owner unable to
		// admit themselves. This stub reads back its own writes, so it catches
		// that order.
		const firstAuthz = spaceWrites.findIndex((w) => w.collection === 'group.opensocial.role');
		expect(firstAuthz).toBeGreaterThan(-1);
		expect(spaceWrites.indexOf(membership!)).toBeLessThan(firstAuthz);
	});

	// The authz config is records too, so a peer app reading the members space
	// can answer "what may an admin do here" without our database. The community
	// record uses the standard's identifiers, because a peer app can only check
	// what it can name. The eventPermissions record uses ours, because the
	// standard defines none.
	// The standard keeps visibility in the meta space's access record, where a
	// simplespace host never reads it. The host enforces the read policy, so the
	// record is written to say the same thing, before the declaration.
	it.each(['public', 'private'] as const)(
		'writes the about space’s access record for a %s group, saying what its read policy says',
		async (visibility) => {
			const pds = stubPds();
			const { spaceWrites } = pds;

			await runCreateGroup(env, OWNER, data({ visibility }));

			const meta = `at://${MINTED_DID}/space/group.opensocial.meta/self`;
			const access = spaceWrites.filter(
				(w) => w.collection === 'group.opensocial.access' && w.space === meta
			);
			expect(access).toHaveLength(1);
			expect(access[0]).toMatchObject({ rkey: 'self' });
			expect(access[0].record).toEqual({
				$type: 'group.opensocial.access',
				public: visibility === 'public',
				readRoles: ['owner', 'admin', 'member'],
				grants: []
			});
			if (visibility === 'public') {
				// Before the declaration, so a declared group's access never says private.
				const order = pds
					.writes()
					.map((w) => `${w.body?.collection}${w.body?.space ? ` ${w.body.space}` : ''}`);
				expect(order.indexOf(`group.opensocial.access ${meta}`)).toBeGreaterThan(-1);
				expect(order.indexOf(`group.opensocial.access ${meta}`)).toBeLessThan(
					order.indexOf('group.opensocial.declaration')
				);
			}
		}
	);

	// The standard indexes every space in members/self, the two well-known ones
	// included, exactly once each.
	it('indexes both spaces in the members space, one entry each', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const [group] = (await rows('groups')) as { created_at: number }[];
		const members = `at://${MINTED_DID}/space/group.opensocial.members/self`;
		const index = spaceWrites.filter((w) => w.collection === 'group.opensocial.space');
		expect(index.map((w) => w.record.space)).toEqual([
			`at://${MINTED_DID}/space/group.opensocial.meta/self`,
			members
		]);
		for (const entry of index) {
			expect(entry.space).toBe(members);
			expect(entry.rkey).toMatch(/^[234567a-z]{13}$/);
			expect(entry.record).toEqual({
				$type: 'group.opensocial.space',
				space: entry.record.space,
				createdAt: new Date(group.created_at).toISOString()
			});
		}
		expect(new Set(index.map((w) => w.rkey)).size).toBe(2);
	});

	it('writes one role record per seeded role and both binding records', async () => {
		const { spaceWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const members = `at://${MINTED_DID}/space/group.opensocial.members/self`;
		const roles = spaceWrites.filter((w) => w.collection === 'group.opensocial.role');
		expect(roles.map((w) => w.rkey)).toEqual(['owner', 'admin', 'member']);
		expect(roles.every((w) => w.space === members)).toBe(true);
		// Keyed by the role id. The standard requires a display name, derived from it.
		expect(roles[1].record).toEqual({ $type: 'group.opensocial.role', displayName: 'Admin' });

		const permissions = spaceWrites.find((w) => w.collection === 'group.opensocial.permissions');
		expect(permissions).toMatchObject({ space: members, rkey: 'self' });
		expect(permissions?.record).toEqual({
			$type: 'group.opensocial.permissions',
			roles: [
				{
					role: 'owner',
					actions: ['group.configure', 'admit', 'eject', 'role.assign'],
					assignable: ['owner', 'admin', 'member']
				},
				{
					role: 'admin',
					actions: ['group.configure', 'admit', 'eject', 'role.assign'],
					assignable: ['admin', 'member']
				},
				// Bound to nothing is a different statement from not bound, and the
				// seeded member holds nothing at either altitude.
				{ role: 'member', actions: [], assignable: [] }
			],
			defaultRoles: ['member']
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

		const rules = spaceWrites.filter((write) => write.collection === 'group.opensocial.rule');
		expect(rules.map((write) => write.record.text)).toEqual(['Be kind', 'No spam']);
		expect(rules.map((write) => write.record.title)).toEqual(['Be kind', 'No spam']);
		expect(rules.map((write) => write.record.order)).toEqual([0, 1]);
		// Distinct TIDs, so each rule has its own address.
		expect(new Set(rules.map((write) => write.rkey)).size).toBe(2);
	});

	// Everything is keyed on the minted DID. The only name returned is the
	// handle the PDS registered, never the submitted label, because the PDS
	// decided the name. No column stores another name, so a caller that wants to
	// address this group has the DID and a handle it must resolve.
	it('returns the minted DID and the registered handle, keys the row on the DID, and stores no credential', async () => {
		stubPds();

		const result = await runCreateGroup(env, OWNER, data({ label: 'kona' }));

		expect(result).toMatchObject({
			ok: true,
			groupDid: MINTED_DID,
			handle: 'konatrail.group.stub.test'
		});
		const [group] = (await rows('groups')) as { group_did: string }[];
		expect(group.group_did).toBe(MINTED_DID);
		// No table for credentials exists any more, and the session token the
		// create wrote with is in no row.
		const tables = harness.raw
			.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`)
			.all() as { name: string }[];
		expect(tables.map((t) => t.name)).not.toContain('group_credentials');
		expect(everyStoredRow()).not.toContain('master-jwt');
	});

	// A rebuild restores the group's creation date from its profile and the
	// owner's join date from their membership, so every dated record a create
	// writes must carry the row's own instant, not each writer's own, later "now".
	it('stamps every dated record it writes with the row’s creation time', async () => {
		const { spaceWrites, repoWrites } = stubPds();

		await runCreateGroup(env, OWNER, data());

		const [group] = (await rows('groups')) as { created_at: number }[];
		const written = [...spaceWrites, ...repoWrites];
		const stamped = written.filter((w) => 'createdAt' in w.record);
		expect(stamped.map((w) => w.collection)).toEqual(
			expect.arrayContaining([
				'group.opensocial.profile',
				'group.opensocial.declaration',
				'group.opensocial.membership',
				'group.opensocial.space',
				'net.openmeet.group.eventPermissions'
			])
		);
		expect(new Set(stamped.map((w) => w.record.createdAt))).toEqual(
			new Set([new Date(group.created_at).toISOString()])
		);
		// The standard dates none of these, and nothing reads a date back from them.
		expect(
			new Set(written.filter((w) => !('createdAt' in w.record)).map((w) => w.collection))
		).toEqual(
			new Set(['group.opensocial.access', 'group.opensocial.role', 'group.opensocial.permissions'])
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
		expect(group.about_space_uri).toBe(`at://${MINTED_DID}/space/group.opensocial.meta/self`);
		expect(group.members_space_uri).toBe(`at://${MINTED_DID}/space/group.opensocial.members/self`);
	});
});

// A group's about space is readable by exactly the audience its visibility
// names, and the host enforces that, not our pages. So the create choice has to
// reach the host: an about space provisioned public for a private group would
// let any signed-in stranger's app read its profile and rules from the PDS.
describe('the create choice sets the about space’s read policy', () => {
	const ABOUT = `at://${MINTED_DID}/space/group.opensocial.meta/self`;

	it.each([
		['public', 'publicPolicy'],
		['private', 'memberListPolicy']
	] as const)(
		'a %s create with approval on provisions the about space with %s',
		async (visibility, policy) => {
			const { requests, spaces } = stubPds();

			const result = await runCreateGroup(env, OWNER, data({ visibility, requireApproval: true }));

			expect(result.ok).toBe(true);
			const about = requests.filter(
				(r) =>
					r.nsid === 'com.atproto.simplespace.createSpace' &&
					r.body?.spaceType === 'group.opensocial.meta'
			);
			expect(about).toHaveLength(1);
			expect(about[0].body?.readPolicy).toEqual({
				$type: `com.atproto.simplespace.defs#${policy}`
			});
			// And that is what the host now reports for it.
			expect(spaces.get(ABOUT)?.readPolicy).toEqual({
				$type: `com.atproto.simplespace.defs#${policy}`
			});
		}
	);
});

// The owner goes on both of the group's member lists. The about space's entry
// is what lets the owner read a private group's face at the host from any app,
// and a public group gets it too, so a later flip needs no backfill. The
// members space's entry is write-only: it makes the host track the acceptance
// the owner writes (spec 003 FR-206) and grants no read of the roster. Both
// follow the owner's membership record.
describe('the create puts the owner on both member lists', () => {
	const ABOUT = `at://${MINTED_DID}/space/group.opensocial.meta/self`;
	const MEMBERS = `at://${MINTED_DID}/space/group.opensocial.members/self`;

	it.each(['public', 'private'] as const)(
		'a %s create puts the owner on the lists after the owner’s membership record',
		async (visibility) => {
			const { requests, listed, members } = stubPds();

			const result = await runCreateGroup(env, OWNER, data({ visibility }));

			expect(result.ok).toBe(true);
			const membership = requests.findIndex(
				(r) =>
					r.nsid === 'com.atproto.space.putRecord' &&
					r.body?.collection === 'group.opensocial.membership' &&
					r.body?.rkey === OWNER
			);
			const puts = requests.filter((r) => r.nsid === 'com.atproto.simplespace.putMember');
			const firstPut = requests.findIndex((r) => r.nsid === 'com.atproto.simplespace.putMember');
			expect(membership).toBeGreaterThan(-1);
			expect(firstPut).toBeGreaterThan(membership);
			expect(puts.map((r) => r.body)).toEqual([
				{ space: MEMBERS, did: OWNER, read: false, write: true },
				{ space: ABOUT, did: OWNER, read: true, write: false }
			]);
			expect(listed(ABOUT)).toEqual([OWNER]);
			expect(members(MEMBERS)).toEqual([{ did: OWNER, read: false, write: true }]);
		}
	);
});

// The members space holds the control plane (roles, memberships, permission
// bindings). Public read there would publish the roster of every group, so the
// visibility choice must not move it.
describe('the members space is member-list read whatever the choice', () => {
	const MEMBERS = `at://${MINTED_DID}/space/group.opensocial.members/self`;

	it.each(['public', 'private'] as const)(
		'a %s create provisions the members space with memberListPolicy',
		async (visibility) => {
			const { requests, spaces } = stubPds();

			const result = await runCreateGroup(env, OWNER, data({ visibility }));

			expect(result.ok).toBe(true);
			const members = requests.filter(
				(r) =>
					r.nsid === 'com.atproto.simplespace.createSpace' &&
					r.body?.spaceType === 'group.opensocial.members'
			);
			expect(members).toHaveLength(1);
			expect(members[0].body?.readPolicy).toEqual({
				$type: 'com.atproto.simplespace.defs#memberListPolicy'
			});
			expect(spaces.get(MEMBERS)?.readPolicy).toEqual({
				$type: 'com.atproto.simplespace.defs#memberListPolicy'
			});
		}
	);
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
	const refuseInsert = async (table: 'groups') => {
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
		['inserting the group row', () => refuseInsert('groups'), {}],
		[
			'provisioning the spaces',
			async () => {},
			{
				fail: (nsid: string) =>
					nsid.startsWith('com.atproto.simplespace.createSpace') ? pdsDown() : undefined
			}
		],
		['writing the profile', async () => {}, { fail: writing('group.opensocial.profile') }],
		['writing the members space', async () => {}, { fail: writing('group.opensocial.access') }],
		[
			'adding the owner to the member list',
			async () => {},
			{
				fail: (nsid: string) =>
					nsid.startsWith('com.atproto.simplespace.putMember') ? pdsDown() : undefined
			}
		],
		[
			// Inside the mint, after createAccount: the account exists, and a
			// response with no session is the PDS's failure, not the creator's.
			'reading the session createAccount returned',
			async () => {},
			{
				account: () => Response.json({ did: MINTED_DID, handle: 'konatrail.group.stub.test' })
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

	it('says the group PDS has no Spaces when createSpace is not served', async () => {
		stubPds({
			fail: (nsid) =>
				nsid.startsWith('com.atproto.simplespace.createSpace')
					? Response.json(
							{ error: 'MethodNotImplemented', message: 'Method Not Implemented' },
							{ status: 501 }
						)
					: undefined
		});

		const result = await runCreateGroup(env, OWNER, data());

		expect(result).toMatchObject({
			ok: false,
			error: expect.stringContaining('does not support Spaces'),
			registered: { groupDid: MINTED_DID, recoveryKey: expect.stringMatching(/^z/) }
		});
	});

	it('names both halves of the fix when the profile write fails', async () => {
		stubPds({ fail: writing('group.opensocial.profile') });

		const result = await runCreateGroup(env, OWNER, data());

		// The members-space step never ran, and a settings save does not write it.
		// Both need a linked group, since the mint's session is gone by then.
		expect(result.ok).toBe(false);
		expect(result).toMatchObject({
			error: expect.stringContaining("Link the group's account from its page")
		});
		expect(result).toMatchObject({
			error: expect.stringContaining('save its settings to write them')
		});
		expect(result).toMatchObject({ error: expect.stringContaining('"Repair this group"') });
	});

	it('carries no key when the create fails before the mint', async () => {
		const { calls } = stubPds();
		const result = await runCreateGroup(env, OWNER, data({ label: 'x' }));
		expect(result.ok).toBe(false);
		expect(calls).not.toContain('com.atproto.server.createAccount');
		expect(result).not.toHaveProperty('registered');
	});
});

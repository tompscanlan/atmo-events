// The repository against the real schema: creation-as-one-transaction, the
// approval flow, and what browse lists. Each case is a rule a route trusts
// without re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS } from '../permissions';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { membersSpaceReader, type CountingSpaceReader } from './__fixtures__/members-space';
import {
	GroupRuleError,
	addMember,
	approveJoinRequest,
	changeMemberRole,
	countActiveMembers,
	createGroup,
	getCallerMembership,
	getGroupByDid,
	listGroups,
	listJoinRequests,
	listMembers,
	recordGroupSpaces,
	rehearseCreateGroup,
	removeMember,
	requestJoin,
	rolePermissions
} from './repo';

import { spaceUri } from '../ids';
const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

function group(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
	return createGroup(db, {
		groupDid: 'did:plc:jcwgw6fcnb5vyoid7nz7sl26',
		ownerDid: OWNER,
		name: 'Kona',
		...overrides
	});
}

describe('createGroup', () => {
	it('seeds the three roles with their bundles and exactly one active owner', async () => {
		const created = await group();

		const bundles = await rolePermissions(db, created.id);
		expect(Object.keys(bundles).sort()).toEqual(['admin', 'member', 'owner']);
		for (const [role, expected] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
			expect(bundles[role].slice().sort(), role).toEqual([...expected].sort());
		}

		const members = await listMembers(db, created.id);
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ did: OWNER, role: 'owner' });
		expect(created.require_approval).toBe(1);
		// createGroup does not provision: the spaces are a PDS call the caller makes
		// next, so a fresh row says "not yet" rather than claiming a space exists.
		expect(created.about_space_uri).toBeNull();
		expect(created.members_space_uri).toBeNull();
	});

	it('gives the owner every enforced permission and the applicant none', async () => {
		const created = await group();
		const owner = await getCallerMembership(db, created, OWNER, null);
		expect(owner.role).toBe('owner');
		expect(owner.permissions.has('MANAGE_EVENTS')).toBe(true);

		const stranger = await getCallerMembership(db, created, ALICE, null);
		expect(stranger.role).toBeNull();
		expect(stranger.permissions.size).toBe(0);

		const anonymous = await getCallerMembership(db, created, null, null);
		expect(anonymous.permissions.size).toBe(0);
	});

	// D1 runs a batch as one transaction. The group DID is the only uniqueness a
	// create can trip (the handle registration decides the name, so there is no
	// second reservation), and tripping it must leave nothing behind: not an
	// orphan group with no roles, and not a half-written roster.
	it('rolls the whole creation back when a unique constraint fails', async () => {
		await group();
		await expect(group()).rejects.toThrow(GroupRuleError);
		const rows = harness.raw.prepare('SELECT COUNT(*) AS n FROM groups').get();
		expect(rows).toEqual({ n: 1 });
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 3 });
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 1 });
	});

	// The only uniqueness tag a create can answer with, which is why it is worth
	// pinning: a caller mapping it back to a form field has exactly one field to
	// point at. A different name over the same DID changes nothing.
	it('reports a duplicate DID as did-taken', async () => {
		await group();
		await expect(group({ name: 'Kona, again' })).rejects.toMatchObject({ reason: 'did-taken' });
	});
});

// The create path runs this before the mint, so it must cost nothing: a
// rehearsal that left a row behind would be a worse bug than the one it
// prevents.
describe('rehearseCreateGroup', () => {
	function counts() {
		return ['groups', 'roles', 'role_permissions', 'memberships'].map(
			(table) => harness.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n
		);
	}

	it('proves the row would land and leaves every table as it found it', async () => {
		await group();
		const before = counts();

		await expect(rehearseCreateGroup(db, { ownerDid: ALICE, name: 'Rehearsed' })).resolves.toBe(
			undefined
		);

		expect(counts()).toEqual(before);
	});

	// Drift, as a table that changed under IF NOT EXISTS would present it: the
	// INSERT is refused, and the rehearsal says so with the table's own words.
	it('meets the refusal the real create would meet', async () => {
		harness.raw.exec(
			`CREATE TRIGGER drifted BEFORE INSERT ON groups
			 BEGIN SELECT RAISE(ABORT, 'NOT NULL constraint failed: groups.legacy'); END`
		);
		await expect(rehearseCreateGroup(db, { ownerDid: OWNER, name: 'Kona' })).rejects.toThrow(
			/groups\.legacy/
		);
		expect(counts()).toEqual([0, 0, 0, 0]);
	});
});

// The route lookup. Every group URL carries the DID, so this is the one query
// standing between a request and a page; a handle URL is resolved to a DID
// before it gets here (see ./route-context.ts).
describe('getGroupByDid', () => {
	it('finds the group a DID names, and answers null for a DID it holds none for', async () => {
		const created = await group();

		expect(await getGroupByDid(db, created.group_did)).toMatchObject({
			id: created.id,
			group_did: created.group_did,
			name: 'Kona'
		});
		// Null rather than a throw: "no group here" is the caller's 404 to decide,
		// and it is the same answer a private group gives (route-context.ts).
		expect(await getGroupByDid(db, 'did:plc:nosuchgroup')).toBeNull();
	});
});

describe('joining', () => {
	it('records a pending request and no roster row when approval is required', async () => {
		const created = await group();
		expect(await requestJoin(db, created, ALICE, 'hello', 'public')).toBe('pending');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(membership.pendingRequestId).not.toBeNull();
		expect(await countActiveMembers(db, created.id)).toBe(1);

		// The partial unique index is what stops a second request; the repo turns
		// that refusal into an outcome rather than an error.
		expect(await requestJoin(db, created, ALICE, 'hello again', 'public')).toBe('already-pending');
	});

	it('puts the caller straight on the roster when approval is off', async () => {
		const created = await group({ requireApproval: false });
		expect(await requestJoin(db, created, ALICE, null, 'public')).toBe('joined');
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBe('member');
		expect(await requestJoin(db, created, ALICE, null, 'public')).toBe('already-member');
	});

	it('approves into the chosen role and closes the request in one step', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, null, 'public');
		const pending = (await getCallerMembership(db, created, ALICE, null)).pendingRequestId!;

		await approveJoinRequest(db, created.id, pending, OWNER, 'admin');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		await expect(approveJoinRequest(db, created.id, pending, OWNER)).rejects.toMatchObject({
			reason: 'not-found'
		});
	});

	// A DID can hold a row and a pending request at once only through data that
	// predates the direct add closing requests, or a direct add racing the
	// approval. Approving it anyway would leave the row at its old role while
	// the caller publishes the requested one, and the record wins in the gate.
	// So the approval is refused, as a direct add of a rostered DID is, and
	// neither the row nor the request moves.
	it('refuses to approve a request for a DID already on the roster, and changes nothing', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		harness.raw
			.prepare(
				`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
				 VALUES ('stale', ?, ?, 'pending', 0, 0)`
			)
			.run(created.id, ALICE);

		await expect(approveJoinRequest(db, created.id, 'stale', OWNER, 'admin')).rejects.toMatchObject(
			{ name: 'GroupRuleError', reason: 'constraint' }
		);

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('member');
		expect(membership.pendingRequestId).toBe('stale');
	});

	// A direct add is an answer to the applicant's request, so it closes it.
	// Left pending, the request would sit in the queue for a member, and
	// approving it later would try to admit them a second time.
	it('closes a pending request when the DID is added directly', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, 'hello', 'public');

		await addMember(db, created.id, ALICE, 'admin', OWNER);

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.pendingRequestId).toBeNull();
		expect(await listJoinRequests(db, created.id, 'all')).toMatchObject([
			{ did: ALICE, status: 'approved' }
		]);
		expect(
			harness.raw.prepare(`SELECT decided_by_did AS by FROM join_requests WHERE did = ?`).get(ALICE)
		).toEqual({ by: OWNER });
	});

	// The same holds for an open join by someone whose request predates the
	// group turning approval off: they are in, so the request is answered.
	it('closes a pending request when an open join admits the DID', async () => {
		const created = await group();
		await requestJoin(db, created, ALICE, 'hello', 'public');
		harness.raw.prepare(`UPDATE groups SET require_approval = 0 WHERE id = ?`).run(created.id);

		expect(await requestJoin(db, { ...created, require_approval: 0 }, ALICE, null, 'public')).toBe(
			'joined'
		);

		expect((await getCallerMembership(db, created, ALICE, null)).pendingRequestId).toBeNull();
		expect(await listJoinRequests(db, created.id, 'pending')).toEqual([]);
	});
});

// Two rules in two layers. The create and the settings save refuse the
// open-join configuration (`approvalRefusal`, ../create-group.test.ts and
// ../update-group.test.ts), and `requestJoin` refuses the act. The first alone
// is not enough: a private group that requires approval would still take a
// pending request from a stranger.
describe('private groups are invite-only', () => {
	it('still answers already-member for someone on the roster', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		expect(await requestJoin(db, created, ALICE, null, 'private')).toBe('already-member');
	});
});

// Whether a group takes self-service joins is a question about its visibility,
// and its visibility is what its host enforces: the about space's read policy,
// which the route reads and hands in. D1 does not store it, so what is handed
// in is the only answer, whatever the row's approval setting says.
describe('the join refusal reads the host, not the row', () => {
	// The row's approval is a cache of the profile's join policy, and nothing
	// forces it on for a private group, so a private group can sit at 0. The
	// refusal comes first, before approval is consulted at all.
	it('a private group refuses a join whatever its cached approval says', async () => {
		const created = await group({ requireApproval: false });
		expect(created.require_approval).toBe(0);

		await expect(requestJoin(db, created, ALICE, 'let me in', 'private')).rejects.toMatchObject({
			reason: 'invite-only'
		});
		// A visibility nobody read is not a public one.
		await expect(requestJoin(db, created, ALICE, 'let me in', null)).rejects.toMatchObject({
			reason: 'invite-only'
		});

		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM join_requests').get()).toEqual({ n: 0 });
		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBeNull();
		expect(await countActiveMembers(db, created.id)).toBe(1);
	});

	it('takes a pending request for a group the host reads as public', async () => {
		const created = await group();

		expect(await requestJoin(db, created, ALICE, 'hello', 'public')).toBe('pending');
		expect((await getCallerMembership(db, created, ALICE, null)).pendingRequestId).not.toBeNull();
	});

	it('answers already-member for a DID on the roster, whatever the host says', async () => {
		const created = await group({ requireApproval: false });
		await addMember(db, created.id, ALICE, 'member');

		for (const visibility of ['public', 'private', null] as const) {
			expect(await requestJoin(db, created, ALICE, null, visibility)).toBe('already-member');
		}
	});
});

describe('roster changes', () => {
	it('lets a member leave but never the owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');

		await removeMember(db, created.id, ALICE);
		expect((await getCallerMembership(db, created, ALICE, null)).role).toBeNull();

		// The trigger refuses; the repo must surface that as a rule, not a 500.
		await expect(removeMember(db, created.id, OWNER)).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});

	it('promotes a member to admin, and refuses to promote anyone to owner', async () => {
		const created = await group();
		await addMember(db, created.id, ALICE, 'member');
		await changeMemberRole(db, created.id, ALICE, 'admin');

		const membership = await getCallerMembership(db, created, ALICE, null);
		expect(membership.role).toBe('admin');
		expect(membership.permissions.has('MANAGE_EVENTS')).toBe(true);

		await expect(
			changeMemberRole(db, created.id, ALICE, 'owner' as 'admin')
		).rejects.toBeInstanceOf(Error);
		await expect(changeMemberRole(db, created.id, OWNER, 'admin')).rejects.toMatchObject({
			reason: 'owner-protected'
		});
	});
});

describe('browse visibility', () => {
	const declared = (did: string, createdAt: string) => ({ did, createdAt });
	const names = (entries: Awaited<ReturnType<typeof listGroups>>) =>
		entries.map((e) => e.row?.name ?? e.group_did);

	interface HostedGroup {
		row: GroupRow;
		reader: CountingSpaceReader;
	}

	/** A group with a members space whose authz config is written, holding a
	 *  membership record for each of `members` and for nobody else. */
	async function hostedWithRecords(
		input: Partial<Parameters<typeof createGroup>[1]>,
		members: string[]
	): Promise<HostedGroup> {
		const created = await group(input);
		const space = spaceUri(created.group_did, MEMBERS_SPACE_TYPE, 'self');
		await recordGroupSpaces(db, created.id, {
			aboutSpaceUri: spaceUri(created.group_did, ABOUT_SPACE_TYPE, 'self'),
			membersSpaceUri: space
		});
		return {
			row: { ...created, members_space_uri: space },
			reader: membersSpaceReader(space, created.group_did, members)
		};
	}

	/** The check the browse loader builds: the caller's standing as the group's
	 *  records give it, through the same function every group page gates on. */
	function rosterFromRecords(callerDid: string, hosted: HostedGroup[]) {
		return async (row: GroupRow) => {
			const reader = hosted.find((h) => h.row.id === row.id)?.reader ?? null;
			return (await getCallerMembership(db, row, callerDid, reader)).onRoster;
		};
	}

	// The browse rule is "declared means listed". The declaration index is the
	// enumeration, and the row only names what the index already listed. So a
	// row the index does not hold is not listed, whatever its columns say.
	it('lists what the declaration index holds, not what the table says', async () => {
		await group({ name: 'Declared', groupDid: 'did:plc:a' });
		await group({ name: 'Undeclared', groupDid: 'did:plc:b' });

		const anonymous = await listGroups(db, {
			callerDid: null,
			declared: [declared('did:plc:a', '2026-09-20T00:00:00.000Z')]
		});
		expect(names(anonymous)).toEqual(['Declared']);
	});

	// A declaration from a group this deployment holds no row for is still a
	// group on the network. It is listed with no row, which the page renders by
	// handle or DID and does not link.
	it('lists a declared group it holds no row for, with no row', async () => {
		await group({ name: 'Ours', groupDid: 'did:plc:a' });

		const anonymous = await listGroups(db, {
			callerDid: null,
			declared: [
				declared('did:plc:foreign', '2026-09-22T00:00:00.000Z'),
				declared('did:plc:a', '2026-09-20T00:00:00.000Z')
			]
		});
		expect(anonymous).toEqual([
			{ group_did: 'did:plc:foreign', row: null, declared: true },
			expect.objectContaining({
				group_did: 'did:plc:a',
				row: expect.objectContaining({ name: 'Ours' }),
				declared: true
			})
		]);
	});

	// Declared means listed, and the row only supplies the name. A group that
	// went private withdraws its declaration, and the withdrawal tells our own
	// index at once (`removeGroupDeclaration`), so a declared row is one whose
	// group is still announcing itself.
	it('hydrates a declared row for a signed-in stranger, with no roster check', async () => {
		await group({ name: 'Listed', groupDid: 'did:plc:d' });
		let asked = 0;

		const entries = await listGroups(db, {
			callerDid: BOB,
			declared: [declared('did:plc:d', '2026-09-20T00:00:00.000Z')],
			// A stranger is on no roster, and that does not matter for a
			// declared group.
			onRoster: async () => {
				asked++;
				return false;
			}
		});
		expect(entries).toEqual([
			{
				group_did: 'did:plc:d',
				row: expect.objectContaining({ name: 'Listed' }),
				declared: true
			}
		]);
		expect(asked).toBe(0);
	});

	// A revocation deletes the membership record before the row (`roster.ts`), so
	// a half-failed one leaves a row with no record behind it. Browse reaches an
	// undeclared group only through that row, so the record has the last word.
	it('does not keep an undeclared group for a removed member whose row survived but whose record is gone', async () => {
		const gone = await hostedWithRecords({ name: 'Gone', groupDid: 'did:plc:gone' }, []);
		const kept = await hostedWithRecords({ name: 'Kept', groupDid: 'did:plc:kept' }, [ALICE]);
		await addMember(db, gone.row.id, ALICE, 'member');
		await addMember(db, kept.row.id, ALICE, 'member');

		const entries = await listGroups(db, {
			callerDid: ALICE,
			declared: [],
			onRoster: rosterFromRecords(ALICE, [gone, kept])
		});
		expect(names(entries)).toEqual(['Kept']);
	});

	// The owner cannot be removed (`memberships_owner_undeletable`), so the check
	// would only cost a session and a space read. The reader below would answer "no
	// record" for the owner if it were asked, and it must not be.
	it('keeps the owner undeclared group with no membership record read', async () => {
		const owned = await hostedWithRecords({ name: 'Owned', groupDid: 'did:plc:owned' }, []);

		const entries = await listGroups(db, {
			callerDid: OWNER,
			declared: [],
			onRoster: rosterFromRecords(OWNER, [owned])
		});
		expect(names(entries)).toEqual(['Owned']);
		expect(owned.reader.reads).toBe(0);
	});

	// The bounded exception to the rule above: a caller sees their own and their
	// joined groups undeclared, because a private group that is invisible to its
	// own members has nowhere to be reached from. They come back marked as not
	// declared, which is what browse shows as private.
	it('adds the caller own and joined groups even when private', async () => {
		const secret = await group({ name: 'Secret', groupDid: 'did:plc:d' });
		await addMember(db, secret.id, ALICE, 'member');

		const own = (callerDid: string) => listGroups(db, { callerDid, declared: [] });
		expect(names(await own(OWNER))).toEqual(['Secret']);
		expect(await own(ALICE)).toEqual([
			{ group_did: 'did:plc:d', row: expect.objectContaining({ name: 'Secret' }), declared: false }
		]);
		expect(names(await own(BOB))).toEqual([]);
	});

	it('lists a group once when it is both declared and the caller own', async () => {
		await group({ name: 'Open', groupDid: 'did:plc:a' });

		const entries = await listGroups(db, {
			callerDid: OWNER,
			declared: [declared('did:plc:a', '2026-09-20T00:00:00.000Z')]
		});
		expect(names(entries)).toEqual(['Open']);
	});

	it('orders newest first by declaration time, and caps at the limit', async () => {
		const entries = await listGroups(db, {
			callerDid: null,
			limit: 2,
			declared: [
				declared('did:plc:old', '2026-09-01T00:00:00.000Z'),
				declared('did:plc:new', '2026-09-23T00:00:00.000Z'),
				declared('did:plc:mid', '2026-09-10T00:00:00.000Z')
			]
		});
		expect(names(entries)).toEqual(['did:plc:new', 'did:plc:mid']);
	});

	// Anyone who may admit members can put a DID on many rosters, and every
	// undeclared group the caller does not own costs a record check. So the
	// checks are bounded: newest first, a few at a time, and only as many as it
	// takes to fill the page.
	describe('record checks for undeclared groups', () => {
		/** `n` undeclared groups owned by someone else, with ALICE's row in each.
		 *  Returned newest first, one second apart. */
		async function memberOf(n: number): Promise<string[]> {
			const made: string[] = [];
			for (let i = 0; i < n; i++) {
				const name = `Group ${String(i).padStart(2, '0')}`;
				const created = await group({ name, groupDid: `did:plc:candidate${i}` });
				await addMember(db, created.id, ALICE, 'member');
				harness.raw
					.prepare('UPDATE groups SET created_at = ? WHERE id = ?')
					.run(1_000_000_000 - i * 1000, created.id);
				made.push(name);
			}
			return made;
		}

		/** A check that confirms everyone except `rejected`, and records which
		 *  groups it was asked about, in order, and how many ran at once. */
		function probe(rejected: string[]) {
			const seen = { checked: [] as string[], running: 0, maxRunning: 0 };
			const onRoster = async (row: GroupRow) => {
				seen.checked.push(row.name);
				seen.running++;
				seen.maxRunning = Math.max(seen.maxRunning, seen.running);
				await new Promise((resolve) => setTimeout(resolve, 0));
				seen.running--;
				return !rejected.includes(row.name);
			};
			return { seen, onRoster };
		}

		it('checks newest first, no more than the limit plus the rejections, and at most 6 at once', async () => {
			const all = await memberOf(14);
			const rejected = [all[1], all[4]];
			const { seen, onRoster } = probe(rejected);

			const entries = await listGroups(db, { callerDid: ALICE, declared: [], limit: 10, onRoster });

			expect(names(entries)).toEqual(all.slice(0, 12).filter((n) => !rejected.includes(n)));
			// Ten confirmed fill the page. Two of the checks along the way were
			// rejections, so twelve checks in all, and the two oldest never asked.
			expect(seen.checked).toEqual(all.slice(0, 12));
			expect(seen.maxRunning).toBe(6);
		});

		// Checking only the newest `limit` is not enough: a rejection among them
		// frees a slot an older group can fill, and that group must be checked
		// before it is listed, not listed because it was next.
		it('never lists a group beyond the cutoff unchecked, and checks the next one when a rejection frees a slot', async () => {
			const all = await memberOf(5);
			const rejected = [all[0], all[2]];
			const { seen, onRoster } = probe(rejected);

			const entries = await listGroups(db, { callerDid: ALICE, declared: [], limit: 2, onRoster });

			expect(names(entries)).toEqual([all[1], all[3]]);
			expect(seen.checked).toEqual(all.slice(0, 4));
			for (const name of names(entries)) expect(seen.checked).toContain(name);
		});

		// A failed check is a failed listing, however the checks happen to settle.
		// Two that finish in the same turn must not let the failure slip past as a
		// shorter page.
		it('fails the listing when a check fails, even when another settles alongside it', async () => {
			const all = await memberOf(3);
			const onRoster = async (row: GroupRow) => {
				await Promise.resolve();
				if (row.name === all[1]) throw new Error('the database did not answer');
				return true;
			};

			await expect(
				listGroups(db, { callerDid: ALICE, declared: [], limit: 10, onRoster })
			).rejects.toThrow('the database did not answer');
		});
	});
});

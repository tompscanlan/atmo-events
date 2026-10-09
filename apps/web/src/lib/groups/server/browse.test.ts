// What browse lists, against the real schema. Each case is a rule the browse
// page trusts without re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { membersSpaceReader, type CountingSpaceReader } from './__fixtures__/members-space';
import { spaceUri } from '../ids';
import { createGroup, recordGroupSpaces } from './db/groups';
import { addMember } from './db/roster';
import { listGroups } from './browse';
import { getCallerMembership } from './standing';

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

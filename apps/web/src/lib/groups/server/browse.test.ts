// What browse lists, against the real schema. Each case is a rule the browse
// page trusts without re-checking.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { createGroup } from './db/groups';
import { addMember } from './db/roster';
import { listGroups } from './browse';

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

/** The group every case starts from, unless it says otherwise. */
const KONA = { groupDid: 'did:plc:jcwgw6fcnb5vyoid7nz7sl26', ownerDid: OWNER, name: 'Kona' };

function group(overrides: Partial<Parameters<typeof createGroup>[1]> = {}) {
	return createGroup(db, { ...KONA, ...overrides });
}

describe('browse visibility', () => {
	const declared = (did: string, createdAt: string) => ({ did, createdAt });
	const names = (entries: Awaited<ReturnType<typeof listGroups>>) =>
		entries.map((e) => e.row?.name ?? e.group_did);

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
	it('hydrates a declared row for a signed-in stranger, who is on no roster', async () => {
		await group({ name: 'Listed', groupDid: 'did:plc:d' });

		const entries = await listGroups(db, {
			callerDid: BOB,
			declared: [declared('did:plc:d', '2026-09-20T00:00:00.000Z')]
		});
		expect(entries).toEqual([
			{
				group_did: 'did:plc:d',
				row: expect.objectContaining({ name: 'Listed' }),
				declared: true
			}
		]);
	});

	// No group's space is read for the list (TS 2026-10-15), so the caller's rows
	// are the whole answer for an undeclared group. A revocation deletes the
	// membership record before the row (`real-host.ts`), so a half-failed one leaves
	// a row with no record behind it, and that group is listed: its page, which
	// reads the caller's standing with their own access, is what refuses them.
	it('lists an undeclared group by the caller’s row alone, even one whose record may be gone', async () => {
		const gone = await group({ name: 'Gone', groupDid: 'did:plc:gone' });
		const kept = await group({ name: 'Kept', groupDid: 'did:plc:kept' });
		await addMember(db, gone.id, ALICE, 'member');
		await addMember(db, kept.id, ALICE, 'member');

		const entries = await listGroups(db, { callerDid: ALICE, declared: [] });
		expect(names(entries).sort()).toEqual(['Gone', 'Kept']);
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
});

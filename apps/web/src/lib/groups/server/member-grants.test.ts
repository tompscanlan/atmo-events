// The per-group grant a member's sign-in asks for, what the client metadata
// declares, and the retry when a PDS still holds older metadata. Each case is a
// rule sign-in trusts: a wrong grant set either fails consent or locks someone out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuthResponseError } from '@atcute/oauth-node-client';
import { scopes } from '$lib/atproto/settings';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';

import {
	METADATA_CACHE_MS,
	memberGrant,
	declaredGrants,
	firstAcceptedScope,
	holdsAcceptanceGrant,
	holdsRsvpGrant,
	reauthorizeForGroup,
	signInGrantAttempts
} from './member-grants';

import { createGroup } from './db/groups';
import { addMember, decideJoinRequest, requestJoin } from './db/roster';
const OWNER = 'did:plc:owner';
const ALICE = 'did:plc:alice';
const BOB = 'did:plc:bob';
const KONA = 'did:plc:kona0000000000000000000a';
const HILO = 'did:plc:hilo0000000000000000000b';
const PUNA = 'did:plc:puna0000000000000000000c';

let harness: SqliteD1;
let db: D1Database;

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

async function group(groupDid: string, requireApproval = false) {
	return createGroup(db, {
		groupDid,
		ownerDid: OWNER,
		name: groupDid.slice(8, 12),
		requireApproval
	});
}

/** Backdates a group so it reads as created `ageMs` before `now`. */
async function age(groupDid: string, now: number, ageMs: number) {
	await db
		.prepare(`UPDATE groups SET created_at = ? WHERE group_did = ?`)
		.bind(now - ageMs, groupDid)
		.run();
}

function invalidScope(message: string) {
	return new OAuthResponseError(new Response(null, { status: 400 }), 'invalid_scope', message);
}

describe('memberGrant', () => {
	// One token per group covers both of the member's own records in its spaces:
	// the acceptance, and an RSVP to a members-only event. Writing the RSVP needs
	// create and update with its collection in the same grant, and reading it back
	// from the member's own session needs read_self. Written out, so a changed
	// grant fails here before any consent screen shows it.
	it("the member grant lets a member write and read back their own RSVP in the group's spaces", () => {
		const grant = memberGrant(KONA);
		expect(grant).toBe(
			`space:*?authority=${KONA}&collection=group.opensocial.acceptance&collection=community.lexicon.calendar.rsvp&action=read_self&action=create&action=update&action=delete`
		);
		const scope = `atproto ${grant}`;
		expect(holdsRsvpGrant(scope, KONA, 'put')).toBe(true);
		expect(holdsRsvpGrant(scope, KONA, 'delete')).toBe(true);
		expect(holdsRsvpGrant(scope, KONA, 'read')).toBe(true);
		// The acceptance it always covered, it still covers.
		expect(holdsAcceptanceGrant(scope, KONA, 'create')).toBe(true);
		expect(holdsAcceptanceGrant(scope, KONA, 'delete')).toBe(true);
		// Another group's spaces are not this group's.
		expect(holdsRsvpGrant(scope, HILO, 'put')).toBe(false);
		expect(holdsRsvpGrant(scope, HILO, 'read')).toBe(false);
	});
});

describe('holdsRsvpGrant', () => {
	const RSVP = 'community.lexicon.calendar.rsvp';
	/** The grant a member signed in with before RSVPs joined it, written out. */
	const ACCEPTANCE_ONLY = `space:*?authority=${KONA}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`;

	// The PDS's rule: a write needs its action and its collection in one grant; a
	// read of one's own record needs read_self or read and ignores the
	// collection. A put asks for create when the record is new and update when
	// it is not, so it needs both.
	it('an RSVP grant is read by parameter, and an acceptance-only grant is not one', () => {
		const held = (scope: string) =>
			(['put', 'delete', 'read'] as const).filter((need) => holdsRsvpGrant(scope, KONA, need));

		// A session granted before RSVPs joined the grant holds none of the three.
		expect(held(`atproto ${ACCEPTANCE_ONLY}`)).toEqual([]);
		expect(holdsAcceptanceGrant(`atproto ${ACCEPTANCE_ONLY}`, KONA, 'create')).toBe(true);
		// The same grant with its parameters in another order is the same grant.
		expect(
			held(
				`atproto space:*?action=delete&collection=${RSVP}&action=update&authority=${KONA}&action=read_self&action=create`
			)
		).toEqual(['put', 'delete', 'read']);
		// A put needs update as well as create.
		expect(held(`space:*?authority=${KONA}&collection=${RSVP}&action=create`)).toEqual([]);
		// The actions and the collection must sit in one grant, not across two;
		// a read ignores the collection.
		expect(
			held(
				`space:*?authority=${KONA}&collection=${RSVP}&action=read_self space:*?authority=${KONA}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`
			)
		).toEqual(['read']);
		// Another group's authority is not this group's grant.
		expect(held(`atproto ${memberGrant(HILO)}`)).toEqual([]);
	});
});

describe('declaredGrants', () => {
	it('declares nothing on a deployment with no groups', async () => {
		expect(await declaredGrants(db)).toEqual([]);
	});

	it('declares one grant per group in D1, whoever belongs to it', async () => {
		await group(KONA);
		await group(HILO, true);

		const grants = await declaredGrants(db);
		expect(grants).toHaveLength(2);
		expect(grants.slice().sort()).toEqual([memberGrant(KONA), memberGrant(HILO)].sort());
	});
});

describe('signInGrantAttempts', () => {
	const now = 1_800_000_000_000;

	it('asks for nothing extra when the user is in no group, so the scope string is exactly the base one', async () => {
		await group(KONA);

		const attempts = await signInGrantAttempts(db, ALICE, now);
		expect(attempts).toEqual([[]]);
		expect([...scopes, ...attempts[0]].join(' ')).toBe(scopes.join(' '));
	});

	it('asks for the grant of every group joined or with a pending request, and no other', async () => {
		const kona = await group(KONA);
		const hilo = await group(HILO, true);
		const puna = await group(PUNA, true);
		for (const g of [KONA, HILO, PUNA]) await age(g, now, METADATA_CACHE_MS);

		await addMember(db, kona.id, ALICE, 'member');
		expect(await requestJoin(db, hilo, ALICE, null, 'public')).toBe('pending');
		// A decided request is not a pending one.
		expect(await requestJoin(db, puna, ALICE, null, 'public')).toBe('pending');
		await rejectOnly(puna.id, ALICE);
		// Someone else's membership asks nothing of Alice's sign-in.
		await addMember(db, puna.id, BOB, 'member');

		const [first] = await signInGrantAttempts(db, ALICE, now);
		expect(first.slice().sort()).toEqual([memberGrant(KONA), memberGrant(HILO)].sort());
	});

	it("includes the owner's own groups, since the owner holds a membership", async () => {
		await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);

		expect((await signInGrantAttempts(db, OWNER, now))[0]).toEqual([memberGrant(KONA)]);
	});

	it('retries first without the grants of groups younger than the metadata cache, then with none', async () => {
		const kona = await group(KONA);
		const hilo = await group(HILO);
		await age(KONA, now, METADATA_CACHE_MS);
		await age(HILO, now, METADATA_CACHE_MS - 1);
		await addMember(db, kona.id, ALICE, 'member');
		await addMember(db, hilo.id, ALICE, 'member');

		const attempts = await signInGrantAttempts(db, ALICE, now);
		expect(attempts).toHaveLength(3);
		expect(attempts[0].slice().sort()).toEqual([memberGrant(KONA), memberGrant(HILO)].sort());
		expect(attempts[1]).toEqual([memberGrant(KONA)]);
		expect(attempts[2]).toEqual([]);
	});

	it('skips the young-group retry when every group is old enough', async () => {
		const kona = await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);
		await addMember(db, kona.id, ALICE, 'member');

		expect(await signInGrantAttempts(db, ALICE, now)).toEqual([[memberGrant(KONA)], []]);
	});

	it('falls back to the base scope when the groups tables are missing', async () => {
		const bare = sqliteD1(false);
		try {
			expect(await signInGrantAttempts(bare.db, ALICE, now)).toEqual([[]]);
		} finally {
			bare.close();
		}
	});

	async function rejectOnly(groupId: string, did: string) {
		const row = await db
			.prepare(`SELECT id FROM join_requests WHERE group_id = ? AND did = ? AND status = 'pending'`)
			.bind(groupId, did)
			.first<{ id: string }>();
		await decideJoinRequest(db, groupId, row!.id, OWNER, 'rejected');
	}
});

describe('firstAcceptedScope', () => {
	it('does not fail sign-in when the PDS has not yet seen a new group in the client metadata', async () => {
		const now = 1_800_000_000_000;
		const kona = await group(KONA);
		const hilo = await group(HILO);
		await age(KONA, now, METADATA_CACHE_MS);
		await age(HILO, now, 60_000);
		await addMember(db, kona.id, ALICE, 'member');
		await addMember(db, hilo.id, ALICE, 'member');

		// A PDS whose cached metadata predates the young group: it refuses that grant.
		const tried: string[][] = [];
		const result = await firstAcceptedScope(
			await signInGrantAttempts(db, ALICE, now),
			async (grants) => {
				tried.push(grants);
				if (grants.includes(memberGrant(HILO))) {
					throw invalidScope(`Scope "${memberGrant(HILO)}" is not declared in the client metadata`);
				}
				return grants;
			}
		);

		expect(result).toEqual([memberGrant(KONA)]);
		expect(tried).toHaveLength(2);
	});

	it('signs in with the base scope when the PDS refuses every grant', async () => {
		const result = await firstAcceptedScope([[memberGrant(KONA)], []], async (grants) => {
			if (grants.length > 0) throw invalidScope('refused');
			return 'signed-in';
		});
		expect(result).toBe('signed-in');
	});

	it('does not retry on any other error', async () => {
		let calls = 0;
		const failure = new OAuthResponseError(new Response(null, { status: 400 }), 'invalid_request');
		await expect(
			firstAcceptedScope([[memberGrant(KONA)], []], async () => {
				calls++;
				throw failure;
			})
		).rejects.toBe(failure);
		expect(calls).toBe(1);
	});

	it('rethrows the last refusal when no attempt is left', async () => {
		const last = invalidScope('still refused');
		await expect(
			firstAcceptedScope([[]], async () => {
				throw last;
			})
		).rejects.toBe(last);
	});
});

describe('reauthorizeForGroup', () => {
	const now = 1_800_000_000_000;

	async function memberRow(groupDid: string, did: string) {
		return db
			.prepare(
				`SELECT m.did FROM memberships m JOIN groups g ON g.id = m.group_id
				 WHERE g.group_did = ? AND m.did = ?`
			)
			.bind(groupDid, did)
			.first();
	}

	it("asks for the new group's grant after an open join", async () => {
		const kona = await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);
		expect(await requestJoin(db, kona, ALICE, null, 'public')).toBe('joined');

		const asked = await reauthorizeForGroup(db, ALICE, KONA, now, async (grants) => grants);
		expect(asked).toEqual([memberGrant(KONA)]);
	});

	it("keeps the member's other groups' grants, since the new session replaces the old", async () => {
		const kona = await group(KONA);
		const hilo = await group(HILO);
		await age(KONA, now, METADATA_CACHE_MS * 3);
		await age(HILO, now, METADATA_CACHE_MS);
		await addMember(db, kona.id, ALICE, 'member');
		expect(await requestJoin(db, hilo, ALICE, null, 'public')).toBe('joined');

		const asked = await reauthorizeForGroup(db, ALICE, HILO, now, async (grants) => grants);
		expect(asked).toEqual([memberGrant(KONA), memberGrant(HILO)]);
	});

	it('gives up after one refusal when the new group is younger than the metadata cache', async () => {
		const kona = await group(KONA);
		await age(KONA, now, 60_000);
		await requestJoin(db, kona, ALICE, null, 'public');

		let calls = 0;
		const asked = await reauthorizeForGroup(db, ALICE, KONA, now, async () => {
			calls++;
			throw invalidScope(`Scope "${memberGrant(KONA)}" is not declared in the client metadata`);
		});
		// A retry without the new grant would only reissue what the member already holds.
		expect(asked).toBeNull();
		expect(calls).toBe(1);
	});

	// A refused grant or any other failure costs the member the grant until the
	// next sign-in, never the join.
	it('leaves the join in place when the PDS refuses the grant or fails, and never throws', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const kona = await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);
		await requestJoin(db, kona, ALICE, null, 'public');

		for (const failure of [invalidScope('refused'), new Error('PDS unreachable')]) {
			const asked = await reauthorizeForGroup(db, ALICE, KONA, now, async () => {
				throw failure;
			});
			expect(asked).toBeNull();
			expect(await memberRow(KONA, ALICE)).not.toBeNull();
		}
		warn.mockRestore();
	});
});

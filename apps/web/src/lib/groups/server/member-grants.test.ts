// The per-group grant a member's sign-in asks for, what the client metadata
// declares, and the retry when a PDS still holds older metadata. Each case is a
// rule sign-in trusts: a wrong grant set either fails consent or locks someone out.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OAuthResponseError } from '@atcute/oauth-node-client';
import { scopes } from '$lib/atproto/settings';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, decideJoinRequest, requestJoin } from './repo';
import {
	METADATA_CACHE_MS,
	acceptanceGrant,
	declaredGrants,
	firstAcceptedScope,
	signInGrantAttempts
} from './member-grants';

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

describe('acceptanceGrant', () => {
	it('names the group as authority and only the acceptance collection, with all three write actions', () => {
		expect(acceptanceGrant(KONA)).toBe(
			`space:*?authority=${KONA}&collection=group.opensocial.acceptance&action=create&action=update&action=delete`
		);
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
		expect(grants.slice().sort()).toEqual([acceptanceGrant(KONA), acceptanceGrant(HILO)].sort());
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
		expect(first.slice().sort()).toEqual([acceptanceGrant(KONA), acceptanceGrant(HILO)].sort());
	});

	it("includes the owner's own groups, since the owner holds a membership", async () => {
		await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);

		expect((await signInGrantAttempts(db, OWNER, now))[0]).toEqual([acceptanceGrant(KONA)]);
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
		expect(attempts[0].slice().sort()).toEqual(
			[acceptanceGrant(KONA), acceptanceGrant(HILO)].sort()
		);
		expect(attempts[1]).toEqual([acceptanceGrant(KONA)]);
		expect(attempts[2]).toEqual([]);
	});

	it('skips the young-group retry when every group is old enough', async () => {
		const kona = await group(KONA);
		await age(KONA, now, METADATA_CACHE_MS);
		await addMember(db, kona.id, ALICE, 'member');

		expect(await signInGrantAttempts(db, ALICE, now)).toEqual([[acceptanceGrant(KONA)], []]);
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
				if (grants.includes(acceptanceGrant(HILO))) {
					throw invalidScope(
						`Scope "${acceptanceGrant(HILO)}" is not declared in the client metadata`
					);
				}
				return grants;
			}
		);

		expect(result).toEqual([acceptanceGrant(KONA)]);
		expect(tried).toHaveLength(2);
	});

	it('signs in with the base scope when the PDS refuses every grant', async () => {
		const result = await firstAcceptedScope([[acceptanceGrant(KONA)], []], async (grants) => {
			if (grants.length > 0) throw invalidScope('refused');
			return 'signed-in';
		});
		expect(result).toBe('signed-in');
	});

	it('logs each refusal it retries past, so a member left unconfirmed has a trace', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await firstAcceptedScope(
			[[acceptanceGrant(KONA), acceptanceGrant(HILO)], []],
			async (grants) => {
				if (grants.length > 0)
					throw invalidScope('Scope "x" is not declared in the client metadata');
				return 'signed-in';
			}
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0].join(' ')).toMatch(
			/refused 2 group grants, retrying with 0: Scope "x" is not declared/
		);
		warn.mockRestore();
	});

	it('logs nothing when the first grant set is accepted', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		await firstAcceptedScope([[acceptanceGrant(KONA)], []], async () => 'signed-in');
		expect(warn).not.toHaveBeenCalled();
		warn.mockRestore();
	});

	it('does not retry on any other error', async () => {
		let calls = 0;
		const failure = new OAuthResponseError(new Response(null, { status: 400 }), 'invalid_request');
		await expect(
			firstAcceptedScope([[acceptanceGrant(KONA)], []], async () => {
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

// THE 404 IS THE FEATURE. A group route takes an actor — a DID or a full handle
// — resolves it, looks it up and gates it, and every way that can fail answers
// the SAME refusal. A different status or a different message for "no such DID"
// than for "a private group you are not in" tells anyone holding a DID which of
// the two they are holding, which is the existence oracle om-5oxc8 closed
// (FR-016a, SC-009).
//
// The handle resolver is stubbed at its module boundary, the way the PDS is
// stubbed elsewhere in this directory: what is under test is which branch runs
// and what it answers, not how DoH replies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { actorToDid } from '$lib/atproto/methods';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup } from './repo';
import { GROUP_NOT_FOUND, groupActorToDid, groupPath, groupRouteContext } from './route-context';
import type { GroupRow } from '../types';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const HANDLE = 'kona.group.stub.test';
/** No credential key: these groups have no members space, so the gate resolves
 *  from the rows and never builds a reader. */
const NO_ENV = {};

const resolver = vi.mocked(actorToDid);

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	// Unresolvable by default, so a case that means to exercise the handle path
	// has to say so — and a case that must never touch the resolver fails loudly
	// rather than passing on a lucky stub.
	resolver.mockReset();
	resolver.mockRejectedValue(new Error('no such handle'));
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
});

afterEach(() => harness.close());

/** The refusal as a route sees it: `error()` throws an HttpError carrying the
 *  status and the body, and BOTH halves are what a caller can compare. */
async function refusal(actor: string, callerDid: string | null) {
	try {
		await groupRouteContext(NO_ENV, db, actor, callerDid);
	} catch (e) {
		const http = e as { status: number; body: { message: string } };
		return { status: http.status, message: http.body.message };
	}
	throw new Error(`${actor} was not refused`);
}

describe('one group, two spellings', () => {
	it('answers the same group for a DID and for its handle', async () => {
		resolver.mockResolvedValue(GROUP_DID);

		const byDid = await groupRouteContext(NO_ENV, db, GROUP_DID, OWNER);
		const byHandle = await groupRouteContext(NO_ENV, db, HANDLE, OWNER);

		expect(byDid.group.id).toBe(group.id);
		expect(byHandle.group).toEqual(byDid.group);
		// The gate runs AFTER the resolve, so which spelling the caller typed
		// cannot change what they may do once inside.
		expect(byHandle.membership.role).toBe('owner');
		expect(resolver).toHaveBeenCalledWith(HANDLE);
	});

	// A DID is already the key, so resolving one would be a network round trip
	// bought for nothing — and it would put every published URL behind a resolver
	// that can be down. Every URL the app publishes carries the DID, so this is
	// the path that actually gets walked.
	it('never consults the handle resolver for a did: actor', async () => {
		await groupRouteContext(NO_ENV, db, GROUP_DID, null);
		expect(await groupActorToDid(GROUP_DID)).toBe(GROUP_DID);

		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('every refusal is the same refusal', () => {
	// SC-009. Three unrelated failures, one indistinguishable answer — asserted
	// on the message as well as the status, because a distinct wording is an
	// oracle exactly as much as a distinct code is.
	it('answers an unknown DID, an unresolvable handle and an invisible group identically', async () => {
		const secret = await createGroup(db, {
			groupDid: 'did:plc:secretgroup',
			ownerDid: OWNER,
			name: 'Secret',
			visibility: 'private'
		});

		const answers = [
			await refusal('did:plc:nosuchgroup', STRANGER),
			await refusal('nosuchgroup.group.stub.test', STRANGER),
			await refusal(secret.group_did, STRANGER)
		];

		expect(answers).toEqual([
			{ status: 404, message: GROUP_NOT_FOUND },
			{ status: 404, message: GROUP_NOT_FOUND },
			{ status: 404, message: GROUP_NOT_FOUND }
		]);
	});

	// The other half of the same rule: the gate is a membership test, not a
	// blanket refusal. A private group its own members cannot open is not
	// private, it is broken — and the 404 above would still look right.
	it('lets a member through the door the stranger was refused at', async () => {
		const secret = await createGroup(db, {
			groupDid: 'did:plc:secretgroup',
			ownerDid: OWNER,
			name: 'Secret',
			visibility: 'private'
		});
		await addMember(db, secret.id, MEMBER, 'member');

		const ctx = await groupRouteContext(NO_ENV, db, secret.group_did, MEMBER);
		expect(ctx.group.id).toBe(secret.id);
		expect(ctx.membership.role).toBe('member');
	});
});

describe('groupPath', () => {
	// The canonical address, used by every link and redirect, so a handle a
	// caller typed is never propagated into a URL the app publishes (FR-010a).
	it('addresses a group by DID, with and without a subpage', () => {
		expect(groupPath(group)).toBe(`/groups/${GROUP_DID}`);
		expect(groupPath(group, 'members')).toBe(`/groups/${GROUP_DID}/members`);
	});
});

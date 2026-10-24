// A group route takes an actor (a DID or a full handle), resolves it, looks it
// up and gates it, and every way that can fail gives the same refusal. A
// different status or message for "no such DID" than for "a private group you
// are not in" would tell anyone holding a DID which of the two they hold, and
// so reveal that a private group exists. The one exception is a host that
// cannot say whether the group is private: that is a 503, covered at the end.
//
// The gate reads with the caller's own access: a signed-in
// caller is `readerSession(did)`, and the fake host of ./__fixtures__/reader-host.ts
// decides whom it lets into each space. A signed-out caller has no reader and
// is gated by the group's declaration.
//
// The handle resolver is stubbed at its module boundary, the way the PDS is
// stubbed elsewhere in this directory: what is under test is which branch runs
// and what it answers, not how DoH replies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { actorToDid } from '$lib/atproto/methods';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';

import { GROUP_NOT_FOUND, GROUP_VISIBILITY_UNCHECKED, groupRouteContext } from './route-context';
import { hostDown, spaceReader, type FakeSpaceReader } from './__fixtures__/space-reader';
import { readerSession, resetReaderHost, serveReader } from './__fixtures__/reader-host';
import { seedGroup } from './__fixtures__/seed-group';
import { groupSpaceUris } from '../ids';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord,
	groupMembershipRecord
} from '../members-record';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';

import { callerSession } from './acceptance';
import { createGroup } from './db/groups';
import { addMember } from './db/roster';
import { SpaceAccessDenied } from './space-credential';
import { readStanding } from './standing';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const HANDLE = 'kona.group.stub.test';
const SECRET = 'did:plc:secretgroup';

/** The caller as a route builds it: their own signed-in session, with `scope`
 *  (every read by default), or null when signed out. */
async function caller(did: string | null, scope?: string) {
	return did ? callerSession(readerSession(did, scope)) : null;
}

/** A host holding a group's about-space access record for `visibility`, and a
 *  membership record for each of `members`: what decides whom it lets in. */
function groupHost(
	groupDid: string,
	visibility: GroupVisibility,
	{ members = [], fail }: { members?: string[]; fail?: ReturnType<typeof hostDown> } = {}
): FakeSpaceReader {
	const { aboutSpaceUri, membersSpaceUri } = groupSpaceUris(groupDid);
	const host = spaceReader(groupDid, { fail });
	host.put({
		space: aboutSpaceUri,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		value: {
			...groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: visibility === 'public'
			}),
			$type: GROUP_ACCESS_COLLECTION
		}
	});
	for (const did of members) {
		host.put({
			space: membersSpaceUri,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: did,
			value: {
				...groupMembershipRecord({ subject: did, roles: ['member'] }),
				$type: GROUP_MEMBERSHIP_COLLECTION
			}
		});
	}
	return host;
}

const resolver = vi.mocked(actorToDid);

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	// Unresolvable by default, so a case that means to exercise the handle path
	// has to say so, and a case that must never touch the resolver fails loudly
	// instead of passing on a lucky stub.
	resolver.mockReset();
	resolver.mockRejectedValue(new Error('no such handle'));
	group = await createGroup(db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
});

afterEach(() => {
	harness.close();
	vi.unstubAllGlobals();
	resetReaderHost();
});

/** The refusal as a route sees it: `error()` throws an HttpError carrying the
 *  status and the body, and BOTH halves are what a caller can compare. */
async function refusal(actor: string, callerDid: string | null) {
	try {
		await groupRouteContext(db, actor, await caller(callerDid));
	} catch (e) {
		const http = e as { status: number; body: { message: string } };
		return { status: http.status, message: http.body.message };
	}
	throw new Error(`${actor} was not refused`);
}

describe('one group, two spellings', () => {
	it('answers the same group for a DID and for its handle', async () => {
		resolver.mockResolvedValue(GROUP_DID);

		// No members space, so the rows decide and nothing is read.
		const byDid = await groupRouteContext(db, GROUP_DID, await caller(OWNER));
		const byHandle = await groupRouteContext(db, HANDLE, await caller(OWNER));

		expect(byDid.group.id).toBe(group.id);
		expect(byHandle.group).toEqual(byDid.group);
		// The gate runs AFTER the resolve, so which spelling the caller typed
		// cannot change what they may do once inside.
		expect(byHandle.membership.role).toBe('admin');
		expect(resolver).toHaveBeenCalledWith(HANDLE);
	});
});

describe('every refusal is the same refusal', () => {
	// Three unrelated failures, one answer, signed in or out. The message is
	// checked as well as the status, because a distinct wording gives the group
	// away just as a distinct code does.
	it('answers an unknown DID, an unresolvable handle and an invisible group identically', async () => {
		await seedGroup({ groupDid: SECRET, ownerDid: OWNER, name: 'Secret', harness });
		const host = groupHost(SECRET, 'private');
		serveReader(SECRET, host);

		const answers = [
			await refusal('did:plc:nosuchgroup', STRANGER),
			await refusal('nosuchgroup.group.stub.test', STRANGER),
			await refusal(SECRET, STRANGER),
			await refusal(SECRET, null)
		];

		expect(answers).toEqual([
			{ status: 404, message: GROUP_NOT_FOUND },
			{ status: 404, message: GROUP_NOT_FOUND },
			{ status: 404, message: GROUP_NOT_FOUND },
			{ status: 404, message: GROUP_NOT_FOUND }
		]);
	});

	// The other half of the same rule: the gate is a membership test, not a
	// blanket refusal. A private group its own members cannot open is broken,
	// and the 404 above would still look right.
	it('lets a member through the door the stranger was refused at', async () => {
		const { group: secret } = await seedGroup({
			groupDid: SECRET,
			ownerDid: OWNER,
			name: 'Secret',
			members: { [MEMBER]: 'member' },
			harness
		});
		serveReader(SECRET, groupHost(SECRET, 'private', { members: [MEMBER] }));

		const ctx = await groupRouteContext(db, SECRET, await caller(MEMBER));
		expect(ctx.group.id).toBe(secret.id);
		expect(ctx.membership.role).toBe('member');
	});
});

// A members space that errors confirms nobody, for a read as for a write. The
// row cannot stand in for the record: a removal whose row delete failed leaves
// a row behind, and it must not open a private group while the space is down.
describe('readStanding', () => {
	const down = spaceReader(GROUP_DID, { fail: hostDown(502) });
	let withSpace: GroupRow;

	beforeEach(async () => {
		await addMember(db, group.id, MEMBER, 'member');
		withSpace = {
			...group,
			members_space_uri: `at://${GROUP_DID}/space/group.opensocial.members/self`
		};
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	it('puts a caller off the roster when the members space errors, and grants nothing', async () => {
		const member = await readStanding(db, withSpace, MEMBER, down);
		expect(member.onRoster).toBe(false);
		expect(member.permissions.size).toBe(0);
		// The row still names the role the page shows. It opens no read.
		expect(member.role).toBe('member');
		expect((await readStanding(db, withSpace, STRANGER, down)).onRoster).toBe(false);
	});

	// No permission is granted, but that is "unknown", not "none": a form that
	// then said "Not allowed" would send an owner looking for a role they hold.
	it('marks the standing as unread, with the read error, so a form can say so', async () => {
		const member = await readStanding(db, withSpace, MEMBER, down);
		expect(member.unreadable).toMatch(/getRecord failed: 502|listRecords failed: 502/);
		// A space that failed is not a sign-in that reads no spaces: "try again
		// later" is the right answer, and "sign in again" would be a wrong one.
		expect(member.noSpaceAccess).toBeUndefined();
		const clean = await readStanding(db, group, MEMBER, null);
		expect(clean.unreadable).toBeUndefined();
	});

	// A host that does not let the caller into the members space has answered:
	// they are not on its list. That is a non-member's standing, not an unread one.
	it('puts a caller the members space does not let in off the roster, as an answer and not an error', async () => {
		const refused = spaceReader(GROUP_DID, {
			fail: (call) => new SpaceAccessDenied(call.space, '400 UserNotAuthorized')
		});
		const member = await readStanding(db, withSpace, MEMBER, refused);
		expect(member.onRoster).toBe(false);
		expect(member.permissions.size).toBe(0);
		expect(member.unreadable).toBeUndefined();
		// The row still names the role the page shows. It opens no read.
		expect(member.role).toBe('member');
		expect(console.error).not.toHaveBeenCalled();
	});

	// A signed-in caller with no reader has a sign-in that reads no spaces, so
	// the space is never asked: the row says whether they are on the roster, and
	// their permissions are unknown, which signing in again may fix.
	it('marks the standing noSpaceAccess when the caller is signed in and has no reader', async () => {
		const member = await readStanding(db, withSpace, MEMBER, null);
		expect(member.noSpaceAccess).toBe(true);
		expect(member.onRoster).toBe(true);
		expect(member.unreadable).toBeUndefined();
		expect(member.permissions.size).toBe(0);
		// A group with no members space resolves from its rows, so nothing is
		// unknown, and a signed-out caller has no sign-in to blame.
		expect((await readStanding(db, group, MEMBER, null)).noSpaceAccess).toBeUndefined();
		expect((await readStanding(db, withSpace, null, null)).noSpaceAccess).toBeUndefined();
	});
});

// The gate asks for the group's visibility with the caller's own access: its
// about space's `access` record, read with `com.atproto.space.getRecord`. The
// record is the policy, and the space's read policy at the host, which every
// other app is held to, follows it. The host's refusal to let a caller into the
// about space at all is the same answer as private. A signed-out caller is
// gated by the declaration, which is published exactly while the record says
// public. (Spec: FR-214; spec 003, Amendments 2026-10-15.)
describe('the page gate reads visibility with the caller’s own access', () => {
	const HOSTED = 'did:plc:hostedgroupaaaaaaaaaaaaa';
	const ABOUT = groupSpaceUris(HOSTED).aboutSpaceUri;
	/** The read of the about space's access record: the visibility read. */
	const ACCESS_READ = `get ${ABOUT} ${HOSTED} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`;
	let host: FakeSpaceReader;

	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	/** A group whose host holds its spaces as a create leaves them for
	 *  `visibility`, with `members` on its roster, and whose log starts empty. */
	async function hosted(
		visibility: GroupVisibility,
		options: Parameters<typeof groupHost>[2] = {}
	): Promise<GroupRow> {
		const { group: created } = await seedGroup({
			groupDid: HOSTED,
			ownerDid: OWNER,
			name: 'Hosted',
			members: Object.fromEntries((options.members ?? []).map((did) => [did, 'member'])),
			harness
		});
		host = groupHost(HOSTED, visibility, options);
		serveReader(HOSTED, host);
		return created;
	}

	/** The route's answer, as a caller sees it: 200 with the visibility it
	 *  hands the forms, or the refusal's status and message. */
	async function open(callerDid: string | null, scope?: string) {
		try {
			const ctx = await groupRouteContext(db, HOSTED, await caller(callerDid, scope));
			return { status: 200, visibility: ctx.visibility };
		} catch (e) {
			const http = e as { status: number; body: { message: string } };
			return { status: http.status, message: http.body.message };
		}
	}

	it('refuses an anonymous caller with the standard 404 when the group’s access record says private, and reads no space', async () => {
		await hosted('private');

		expect(await open(null)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		// No space can be read for a signed-out visitor: the declaration decides.
		expect(host.calls).toEqual([]);
	});

	it('admits an anonymous caller to a declared group as public, and reads no space', async () => {
		await hosted('public');

		expect(await open(null)).toEqual({ status: 200, visibility: 'public' });
		expect(host.calls).toEqual([]);
	});

	it('admits a signed-in stranger when the group’s access record says public', async () => {
		await hosted('public');

		expect(await open(STRANGER)).toEqual({ status: 200, visibility: 'public' });
		expect(host.calls).toContain(ACCESS_READ);
		// The record decides: the host's read policy is not asked.
		expect(host.calls.filter((c) => c.startsWith('getSpace'))).toEqual([]);
	});

	// The host does not let a stranger into a private group's about space, so the
	// access record is never read for them, and the refusal is the standard one.
	it('refuses a signed-in stranger with the standard 404 when the host does not let them in', async () => {
		await hosted('private');

		expect(await open(STRANGER)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(host.callsIn(ABOUT)).toEqual([]);
	});

	// Not the 404: a group whose visibility could not be read might be public,
	// and a 404 would tell its visitors it does not exist. What this answer
	// gives away is that a group this deployment hosts sits at the DID, which the
	// PLC log already publishes.
	it('answers 503, visibility could not be checked, when the host does not answer for a stranger', async () => {
		await hosted('public', { fail: hostDown(502, ABOUT) });

		expect(await open(STRANGER)).toEqual({ status: 503, message: GROUP_VISIBILITY_UNCHECKED });
	});

	// A sign-in that reads no spaces gets no reader, so it is gated as a
	// signed-out visitor is: by the declaration, with nothing read in any space.
	it('refuses a signed-in caller whose sign-in reads no spaces from an undeclared group', async () => {
		await hosted('private');

		expect(await open(STRANGER, 'atproto')).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(host.calls).toEqual([]);
	});

	it('admits a signed-in caller whose sign-in reads no spaces to a declared group, with no reader', async () => {
		await hosted('public');

		const ctx = await groupRouteContext(db, HOSTED, await caller(STRANGER, 'atproto'));
		expect(ctx.visibility).toBe('public');
		expect(ctx.reader).toBeNull();
		expect(ctx.membership.noSpaceAccess).toBe(true);
		expect(host.calls).toEqual([]);
	});

	// The membership half does not change: a caller on the roster sees the
	// group at every visibility, so the host is not asked about it, and a
	// visibility read that fails cannot lock out a member whose standing was
	// read.
	it('admits a member on the roster without asking the host, even when the host would fail', async () => {
		await hosted('private', { members: [MEMBER], fail: hostDown(502, ABOUT) });

		expect(await open(MEMBER)).toEqual({ status: 200, visibility: null });
		expect(host.callsIn(ABOUT)).toEqual([]);
	});
});

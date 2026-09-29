// A group route takes an actor (a DID or a full handle), resolves it, looks it
// up and gates it, and every way that can fail gives the same refusal. A
// different status or message for "no such DID" than for "a private group you
// are not in" would tell anyone holding a DID which of the two they hold, and
// so reveal that a private group exists. The one exception is a host that
// cannot say whether the group is private: that is a 503, covered at the end.
//
// The handle resolver is stubbed at its module boundary, the way the PDS is
// stubbed elsewhere in this directory: what is under test is which branch runs
// and what it answers, not how DoH replies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { actorToDid } from '$lib/atproto/methods';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { stubPds } from './__fixtures__/stub-pds';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import {
	GROUP_NOT_FOUND,
	GROUP_VISIBILITY_UNCHECKED,
	groupActorToDid,
	groupPath,
	groupRouteContext,
	readStanding
} from './route-context';
import type { GroupSpaceReader } from './about-read';
import { storeGroupCredential, type GroupCredential } from './credentials';
import { clearGroupSessions } from './session';
import { pdsProvisioner, provisionGroupSpaces } from './spaces';
import type { GroupRow, GroupVisibility } from '../types';

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
	// has to say so, and a case that must never touch the resolver fails loudly
	// instead of passing on a lucky stub.
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
	// for nothing, and it would put every published URL behind a resolver that
	// can be down. Every URL the app publishes carries the DID, so this is the
	// path real traffic takes.
	it('never consults the handle resolver for a did: actor', async () => {
		await groupRouteContext(NO_ENV, db, GROUP_DID, OWNER);
		expect(await groupActorToDid(GROUP_DID)).toBe(GROUP_DID);

		expect(resolver).not.toHaveBeenCalled();
	});
});

describe('every refusal is the same refusal', () => {
	// Three unrelated failures, one answer. The message is checked as well as the
	// status, because a distinct wording gives the group away just as a distinct
	// code does.
	it('answers an unknown DID, an unresolvable handle and an invisible group identically', async () => {
		const secret = await createGroup(db, {
			groupDid: 'did:plc:secretgroup',
			ownerDid: OWNER,
			name: 'Secret'
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
	// blanket refusal. A private group its own members cannot open is broken,
	// and the 404 above would still look right.
	it('lets a member through the door the stranger was refused at', async () => {
		const secret = await createGroup(db, {
			groupDid: 'did:plc:secretgroup',
			ownerDid: OWNER,
			name: 'Secret'
		});
		await addMember(db, secret.id, MEMBER, 'member');

		const ctx = await groupRouteContext(NO_ENV, db, secret.group_did, MEMBER);
		expect(ctx.group.id).toBe(secret.id);
		expect(ctx.membership.role).toBe('member');
	});
});

describe('groupPath', () => {
	// The canonical address, used by every link and redirect, so a handle a
	// caller typed never ends up in a URL the app publishes.
	it('addresses a group by DID, with and without a subpage', () => {
		expect(groupPath(group)).toBe(`/groups/${GROUP_DID}`);
		expect(groupPath(group, 'members')).toBe(`/groups/${GROUP_DID}/members`);
	});
});

// A members space that errors confirms nobody, for a read as for a write. The
// row cannot stand in for the record: a removal whose row delete failed leaves
// a row behind, and it must not open a private group while the space is down.
describe('readStanding', () => {
	const down: GroupSpaceReader = {
		async get() {
			throw new Error('com.atproto.space.getRecord failed: 502');
		},
		async list() {
			throw new Error('com.atproto.space.listRecords failed: 502');
		},
		async getSpace() {
			throw new Error('com.atproto.simplespace.getSpace failed: 502');
		}
	};
	let withSpace: GroupRow;

	beforeEach(async () => {
		await addMember(db, group.id, MEMBER, 'member');
		withSpace = {
			...group,
			members_space_uri: `at://${GROUP_DID}/space/net.openmeet.space.members/self`
		};
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	it('puts a caller off the roster when the members space errors, and grants nothing', async () => {
		const member = await readStanding(db, withSpace, MEMBER, down);
		expect(member.onRoster).toBe(false);
		expect(member.permissions.size).toBe(0);
		// The row still names the role and status the page shows. Neither opens
		// a read.
		expect(member.role).toBe('member');
		expect(member.status).toBe('active');
		expect((await readStanding(db, withSpace, STRANGER, down)).onRoster).toBe(false);
	});

	// No permission is granted, but that is "unknown", not "none": a form that
	// then said "Not allowed" would send an owner looking for a role they hold.
	it('marks the standing as unread, with the read error, so a form can say so', async () => {
		const member = await readStanding(db, withSpace, MEMBER, down);
		expect(member.unreadable).toMatch(/getRecord failed: 502|listRecords failed: 502/);
		const clean = await readStanding(db, group, MEMBER, null);
		expect(clean.unreadable).toBeUndefined();
	});
});

// The gate asks the host. A group's visibility is its about space's read
// policy, read with `com.atproto.simplespace.getSpace`, since the host is what every
// other app is held to.
describe('the page gate reads visibility from the host', () => {
	const HOSTED = 'did:plc:hostedgroupaaaaaaaaaaaaa';
	/** 32 bytes, base64: the credential store accepts nothing shorter. */
	const KEY = btoa('0123456789abcdef0123456789abcdef');
	const ENV = { GROUP_CREDENTIAL_KEY: KEY };
	const CRED: GroupCredential = {
		service: 'https://pds.stub.test',
		identifier: 'hosted.group.stub.test',
		password: 'app-pass-1234'
	};
	const GET_SPACE = 'com.atproto.simplespace.getSpace';

	let pds: ReturnType<typeof stubPds>;
	/** Set by a case to make the host refuse every getSpace. */
	let getSpaceFails: boolean;

	beforeEach(() => {
		clearGroupSessions();
		getSpaceFails = false;
		pds = stubPds({
			did: HOSTED,
			handle: CRED.identifier,
			fail: (nsid) =>
				getSpaceFails && nsid === GET_SPACE
					? Response.json({ error: 'UpstreamFailure' }, { status: 502 })
					: undefined
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		clearGroupSessions();
	});

	/** A group whose about space the host provisioned for `host`. The
	 *  credential is stored unless the case says otherwise, and the host's log
	 *  starts empty. */
	async function hosted(host: GroupVisibility, { credential = true } = {}): Promise<GroupRow> {
		const created = await createGroup(db, {
			groupDid: HOSTED,
			ownerDid: OWNER,
			name: 'Hosted'
		});
		await recordGroupSpaces(
			db,
			created.id,
			await provisionGroupSpaces(pdsProvisioner(CRED, HOSTED), host)
		);
		if (credential) await storeGroupCredential(ENV, db, HOSTED, CRED);
		pds.clearLog();
		return created;
	}

	/** The route's answer, as a caller sees it: 200 with the visibility it
	 *  hands the forms, or the refusal's status and message. */
	async function open(callerDid: string | null) {
		try {
			const ctx = await groupRouteContext(ENV, db, HOSTED, callerDid);
			return { status: 200, visibility: ctx.visibility };
		} catch (e) {
			const http = e as { status: number; body: { message: string } };
			return { status: http.status, message: http.body.message };
		}
	}

	const getSpaceCalls = () => pds.requests.filter((r) => r.nsid === GET_SPACE);

	it('refuses an anonymous caller with the standard 404 when the host reads the group as private', async () => {
		await hosted('private');

		expect(await open(null)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(getSpaceCalls()).toHaveLength(1);
	});

	it('admits a signed-in stranger when the host reads the group as public', async () => {
		await hosted('public');

		expect(await open(STRANGER)).toEqual({ status: 200, visibility: 'public' });
	});

	// Not the 404: a group whose visibility could not be read might be public,
	// and a 404 would tell its visitors it does not exist. What this answer
	// gives away is that a group this deployment hosts sits at the DID, which the
	// PLC log already publishes.
	it('answers 503, visibility could not be checked, when the host does not answer for a stranger', async () => {
		await hosted('public');
		getSpaceFails = true;

		expect(await open(STRANGER)).toEqual({ status: 503, message: GROUP_VISIBILITY_UNCHECKED });
		expect(GROUP_VISIBILITY_UNCHECKED).toContain('visibility could not be checked');
	});

	it('refuses a stranger with the standard 404 when this deployment holds no credential for the group', async () => {
		await hosted('public', { credential: false });

		expect(await open(STRANGER)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(getSpaceCalls()).toEqual([]);
	});

	// The membership half does not change: a caller on the roster sees the
	// group at every visibility, so the host is not asked about it, and a
	// visibility read that fails cannot lock out a member whose standing was
	// read.
	it('admits a member on the roster without asking the host, even when the host would fail', async () => {
		const group = await hosted('private');
		await addMember(db, group.id, MEMBER, 'member');
		getSpaceFails = true;

		expect(await open(MEMBER)).toEqual({ status: 200, visibility: null });
		expect(getSpaceCalls()).toEqual([]);
	});
});

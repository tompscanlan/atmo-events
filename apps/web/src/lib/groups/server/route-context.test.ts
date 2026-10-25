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

import { callerSession } from './caller';
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

async function caller(did: string | null, scope?: string) {
	return did ? callerSession(readerSession(did, scope)) : null;
}

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
	resolver.mockReset();
	resolver.mockRejectedValue(new Error('no such handle'));
	group = await createGroup(db, { groupDid: GROUP_DID, creatorDid: OWNER, name: 'Kona' });
});

afterEach(() => {
	harness.close();
	vi.unstubAllGlobals();
	resetReaderHost();
});

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
	it('answers the same group for a DID and for its handle, gated after the resolve', async () => {
		await seedGroup({ groupDid: SECRET, creatorDid: OWNER, name: 'Secret', harness });
		serveReader(SECRET, groupHost(SECRET, 'private', { members: [MEMBER] }));
		resolver.mockResolvedValue(SECRET);

		const byDid = await groupRouteContext(db, SECRET, await caller(MEMBER));
		const byHandle = await groupRouteContext(db, HANDLE, await caller(MEMBER));

		expect(byHandle.group).toEqual(byDid.group);
		expect(byHandle.membership.onRoster).toBe(true);
		expect(resolver).toHaveBeenCalledWith(HANDLE);
	});
});

describe('every refusal is the same refusal', () => {
	it('answers an unknown DID, an unresolvable handle and an invisible group identically', async () => {
		await seedGroup({ groupDid: SECRET, creatorDid: OWNER, name: 'Secret', harness });
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

	it('lets a member through the door the stranger was refused at', async () => {
		const { group: secret } = await seedGroup({
			groupDid: SECRET,
			creatorDid: OWNER,
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
		expect(member.role).toBe('member');
		expect((await readStanding(db, withSpace, STRANGER, down)).onRoster).toBe(false);
	});

	it('marks the standing as unread, with the read error, so a form can say so', async () => {
		const member = await readStanding(db, withSpace, MEMBER, down);
		expect(member.unreadable).toBeTruthy();
		expect(member.noSpaceAccess).toBeUndefined();
		const clean = await readStanding(db, group, MEMBER, null);
		expect(clean.unreadable).toBeUndefined();
	});

	it('puts a caller the members space does not let in off the roster, as an answer and not an error', async () => {
		const refused = spaceReader(GROUP_DID, {
			fail: (call) => new SpaceAccessDenied(call.space, '400 UserNotAuthorized')
		});
		const member = await readStanding(db, withSpace, MEMBER, refused);
		expect(member.onRoster).toBe(false);
		expect(member.permissions.size).toBe(0);
		expect(member.unreadable).toBeUndefined();
		expect(member.role).toBe('member');
		expect(console.error).not.toHaveBeenCalled();
	});

	it('marks a signed-in caller with no reader noSpaceAccess, and never on the roster', async () => {
		const member = await readStanding(db, withSpace, MEMBER, null);
		expect(member.noSpaceAccess).toBe(true);
		expect(member.onRoster).toBe(false);
		expect(member.unreadable).toBeUndefined();
		expect(member.permissions.size).toBe(0);
		expect((await readStanding(db, group, MEMBER, null)).noSpaceAccess).toBeUndefined();
		expect((await readStanding(db, withSpace, null, null)).noSpaceAccess).toBeUndefined();
	});
});

describe('the page gate reads visibility with the caller’s own access', () => {
	const HOSTED = 'did:plc:hostedgroupaaaaaaaaaaaaa';
	const ABOUT = groupSpaceUris(HOSTED).aboutSpaceUri;
	const ACCESS_READ = `get ${ABOUT} ${HOSTED} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`;
	let host: FakeSpaceReader;

	beforeEach(() => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => vi.restoreAllMocks());

	async function hosted(
		visibility: GroupVisibility,
		options: Parameters<typeof groupHost>[2] = {}
	): Promise<GroupRow> {
		const { group: created } = await seedGroup({
			groupDid: HOSTED,
			creatorDid: OWNER,
			name: 'Hosted',
			members: Object.fromEntries((options.members ?? []).map((did) => [did, 'member'])),
			harness
		});
		host = groupHost(HOSTED, visibility, options);
		serveReader(HOSTED, host);
		return created;
	}

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
		expect(host.calls.filter((c) => c.startsWith('getSpace'))).toEqual([]);
	});

	it('refuses a signed-in stranger with the standard 404 when the host does not let them in', async () => {
		await hosted('private');

		expect(await open(STRANGER)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(host.callsIn(ABOUT)).toEqual([]);
	});

	it('answers 503, visibility could not be checked, when the host does not answer for a stranger', async () => {
		await hosted('public', { fail: hostDown(502, ABOUT) });

		expect(await open(STRANGER)).toEqual({ status: 503, message: GROUP_VISIBILITY_UNCHECKED });
	});

	it('refuses a group whose create stopped before its spaces with the standard 404', async () => {
		await seedGroup({
			groupDid: HOSTED,
			creatorDid: OWNER,
			name: 'Hosted',
			spaces: false,
			harness
		});
		host = groupHost(HOSTED, 'public');
		serveReader(HOSTED, host);

		expect(await open(STRANGER)).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		expect(host.callsIn(ABOUT)).toEqual([]);
	});

	it('refuses an undeclared group to a sign-in that reads no spaces, even with a roster row', async () => {
		await hosted('private', { members: [MEMBER] });

		for (const did of [STRANGER, MEMBER]) {
			expect(await open(did, 'atproto')).toEqual({ status: 404, message: GROUP_NOT_FOUND });
		}
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

	it('admits a member on the roster without asking the host, even when the host would fail', async () => {
		await hosted('private', { members: [MEMBER], fail: hostDown(502, ABOUT) });

		expect(await open(MEMBER)).toEqual({ status: 200, visibility: null });
		expect(host.callsIn(ABOUT)).toEqual([]);
	});
});

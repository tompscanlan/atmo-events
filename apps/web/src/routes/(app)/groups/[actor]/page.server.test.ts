import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/groups/server/handles', () => ({
	refreshGroupHandle: vi.fn(async () => null)
}));
vi.mock('$lib/groups/server/people', () => ({ loadPeople: vi.fn(async () => ({})) }));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { loadPeople } from '$lib/groups/server/people';
import { notAllowed } from '$lib/groups/form-error';
import {
	hostDown,
	spaceReader,
	type FakeSpaceReader,
	type SpaceReadCall,
	type SpaceRecordInput
} from '$lib/groups/server/__fixtures__/space-reader';
import { acceptanceRecords, authzRecords } from '$lib/groups/server/__fixtures__/host-records';
import {
	admitOnly,
	declare,
	fixtureSessions,
	memberWrites,
	READ_EVERYTHING,
	readerSession,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import { linkGroups, unlinkAllGroups } from '$lib/groups/server/__fixtures__/linked-group';
import {
	ABOUT_SPACE_TYPE,
	publicGroup,
	type CallerMembership,
	type GroupRow,
	type GroupVisibility
} from '$lib/groups/types';
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '$lib/groups/about-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';
import { groupSpaceUris } from '$lib/groups/ids';
import { addMember } from '$lib/groups/server/db/roster';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);
const ACCESS_READ = `get ${ABOUT} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`;
const META_ONLY = 'atproto space:group.opensocial.meta?authority=*&action=read';
const PROFILE: SpaceRecordInput = {
	space: ABOUT,
	collection: GROUP_PROFILE_COLLECTION,
	rkey: 'self',
	value: { displayName: 'Kona Paddlers', joinPolicy: 'approval' }
};
const RULE: SpaceRecordInput = {
	space: ABOUT,
	collection: GROUP_RULE_COLLECTION,
	rkey: '3lrule',
	value: { text: 'Wear a leash', order: 1 }
};

let harness: SqliteD1;
let row: GroupRow;

beforeEach(async () => {
	({ harness, group: row } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	resetReaderHost();
	unlinkAllGroups();
});

function aboutAccess(visibility: GroupVisibility): SpaceRecordInput {
	return {
		space: ABOUT,
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
	};
}

const accessReadFails =
	(error: Error) =>
	(call: SpaceReadCall): Error | undefined =>
		call.method === 'get' && call.space === ABOUT && call.collection === GROUP_ACCESS_COLLECTION
			? error
			: undefined;

const ROSTER = { [OWNER]: 'admin', [MEMBER]: 'member' } as const;

/** A host whose members space holds `roster`'s records and whose meta access says
 *  `visibility`, or whose access read fails with the error. */
function groupHost(
	visibility: GroupVisibility | Error,
	{
		records = [],
		roster = ROSTER
	}: { records?: SpaceRecordInput[]; roster?: Record<string, 'admin' | 'member'> } = {}
): FakeSpaceReader {
	const held = [...authzRecords(GROUP_DID, roster), ...records];
	const host =
		visibility instanceof Error
			? spaceReader(GROUP_DID, { records: held, fail: accessReadFails(visibility) })
			: spaceReader(GROUP_DID, { records: [aboutAccess(visibility), ...held] });
	serveReader(GROUP_DID, host);
	return host;
}

type GroupPage = Record<string, unknown> & {
	visibility: string | null;
	about: { name: string; joinPolicy: string | null; rules: { text: string }[] };
	membership: CallerMembership;
	group: unknown;
	listed: boolean;
	canSeeMembers: boolean;
	canManageGroup: boolean;
	canAdmitMembers: boolean;
	groupLinked: boolean | null;
	hiddenDetails: 'signed-out' | 'no-access' | null;
	rosterPreview: { did: string }[];
	memberCount: number;
	confirmPrompt: boolean;
};

async function openAs(
	did: string | null,
	{ env = {}, scope, actor = GROUP_DID }: { env?: object; scope?: string; actor?: string } = {}
): Promise<GroupPage> {
	return (await load({
		params: { actor },
		locals: { did, session: did ? readerSession(did, scope) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions, ...env } },
		url: new URL(`https://atmo.test/groups/${actor}`)
	} as unknown as Parameters<typeof load>[0])) as GroupPage;
}

const visibilityReads = (host: FakeSpaceReader) => host.calls.filter((c) => c === ACCESS_READ);

describe('the group and its face', () => {
	it.each([
		[OWNER, 'public'],
		[OWNER, 'private'],
		[STRANGER, 'public']
	] as const)(
		'%s sees the visibility a %s access record says, read once',
		async (did, visibility) => {
			const host = groupHost(visibility);
			const data = await openAs(did);

			expect(data.visibility).toBe(visibility);
			expect(visibilityReads(host)).toEqual([ACCESS_READ]);
			expect(data.group).toStrictEqual(publicGroup(row));
			expect(data).not.toHaveProperty('ownerDid');
			expect(data.about).toMatchObject({ name: 'Kona', joinPolicy: null });
		}
	);

	it("shows a member's page with no visibility when the host cannot say", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		groupHost(new Error('com.atproto.space.getRecord failed: 502'));
		expect((await openAs(MEMBER)).visibility).toBeNull();
	});

	it("reads a signed-in non-member a public group's profile and rules with their own credential", async () => {
		groupHost('public', { records: [PROFILE, RULE] });
		const data = await openAs(STRANGER);

		expect(data.about).toMatchObject({ name: 'Kona Paddlers', joinPolicy: 'approval' });
		expect(data.about.rules.map((rule) => rule.text)).toEqual(['Wear a leash']);
		expect(data.hiddenDetails).toBeNull();
		const asked = vi
			.mocked(globalThis.fetch)
			.mock.calls.filter(([input]) => String(input).includes('getDelegationToken'))
			.map(([, init]) => new Headers(init?.headers).get('authorization'));
		expect(new Set(asked)).toEqual(new Set([`Bearer member ${STRANGER}`]));
		expect(fixtureSessions.reads).toBe(0);
	});

	it('reads nothing for a signed-out visitor, who sees the row and the notice', async () => {
		const host = groupHost('public', { records: [PROFILE, RULE] });
		const data = await openAs(null);

		expect(host.calls).toEqual([]);
		expect(fixtureSessions.reads).toBe(0);
		expect(data.about).toMatchObject({ name: 'Kona', rules: [] });
		expect(data).toMatchObject({ visibility: 'public', hiddenDetails: 'signed-out' });
	});

	it('reads nothing for an owner whose sign-in reads no spaces, and says why', async () => {
		const host = groupHost('public');
		const data = await openAs(OWNER, { scope: 'atproto' });
		expect(data).toMatchObject({ visibility: 'public', hiddenDetails: 'no-access' });
		expect(host.calls).toEqual([]);
	});

	it('answers a private group with the 404 a missing group gets', async () => {
		groupHost('private', { records: [PROFILE] });
		const missing = openAs(STRANGER, { actor: 'did:plc:nosuchgroup' });
		await expect(missing).rejects.toMatchObject({ status: 404 });
		await expect(openAs(null)).rejects.toMatchObject({ status: 404 });
		await expect(openAs(STRANGER)).rejects.toMatchObject({ status: 404 });
	});

	it('tells only a manager whether the group is listed', async () => {
		groupHost('public');
		expect((await openAs(OWNER)).listed).toBe(true);
		expect((await openAs(MEMBER)).listed).toBe(false);
		declare(GROUP_DID, false);
		expect((await openAs(OWNER)).listed).toBe(false);
	});
});

describe('the roster preview', () => {
	it('shows a member the faces', async () => {
		groupHost('public', { records: acceptanceRecords(GROUP_DID, [OWNER, MEMBER]) });
		const data = await openAs(MEMBER);
		expect(data.rosterPreview.map((entry) => entry.did).sort()).toEqual([MEMBER, OWNER]);
		expect(data.confirmPrompt).toBe(false);
	});

	it('leaves out, and does not count, a member who has not confirmed', async () => {
		groupHost('public', { records: acceptanceRecords(GROUP_DID, [MEMBER]) });
		const data = await openAs(MEMBER);
		expect(data.rosterPreview.map((entry) => entry.did)).toEqual([MEMBER]);
		expect(data.memberCount).toBe(1);
	});

	it("writes a visiting member's missing acceptance when their sign-in can", async () => {
		const host = groupHost('public', { records: acceptanceRecords(GROUP_DID, [OWNER]) });
		const data = await openAs(MEMBER, {
			scope: `${READ_EVERYTHING} space:group.opensocial.members?authority=*&collection=group.opensocial.acceptance&action=read&action=create&action=delete`
		});
		expect(memberWrites.map((w) => [w.did, w.nsid, w.space])).toEqual([
			[MEMBER, 'com.atproto.space.createRecord', MEMBERS]
		]);
		expect(data.rosterPreview.map((entry) => entry.did).sort()).toEqual([MEMBER, OWNER]);
		expect(data.confirmPrompt).toBe(false);
		expect(
			host.peek({
				space: MEMBERS,
				repo: MEMBER,
				collection: 'group.opensocial.acceptance',
				rkey: 'self'
			})
		).not.toBeNull();
	});

	it('offers a member whose sign-in cannot write their acceptance to confirm', async () => {
		groupHost('public', { records: acceptanceRecords(GROUP_DID, [OWNER]) });
		const data = await openAs(MEMBER);
		expect(memberWrites).toEqual([]);
		expect(data.confirmPrompt).toBe(true);
		expect(data.rosterPreview.map((entry) => entry.did)).toEqual([OWNER]);
	});

	it.each([
		['a signed-in stranger', STRANGER],
		['a signed-out caller', null]
	])('shows %s the count only, and looks no member up', async (_, did) => {
		groupHost('public');
		const data = await openAs(did);

		expect(data.rosterPreview).toEqual([]);
		expect(data.memberCount).toBe(2);
		const looked = vi.mocked(loadPeople).mock.calls.flatMap(([, dids]) => dids);
		expect(looked).not.toContain(OWNER);
		expect(looked).not.toContain(MEMBER);
	});
});

describe('a members space that cannot be read', () => {
	const REMOVED = 'did:plc:removed';

	beforeEach(async () => {
		await addMember(harness.db, row.id, REMOVED, 'member');
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	/** The host lets everyone in, and every read of the members space fails. */
	function membersDown(visibility: GroupVisibility | Error): FakeSpaceReader {
		const membersFail = hostDown(502, MEMBERS);
		const accessFail = visibility instanceof Error ? accessReadFails(visibility) : undefined;
		const host = spaceReader(GROUP_DID, {
			records: [
				...(visibility instanceof Error ? [] : [aboutAccess(visibility)]),
				PROFILE,
				...authzRecords(GROUP_DID, ROSTER)
			],
			fail: (call) => membersFail(call) ?? accessFail?.(call)
		});
		serveReader(GROUP_DID, host);
		admitOnly(GROUP_DID, () => true);
		return host;
	}

	it('does not open a private group to a stale row, nor read its profile', async () => {
		const host = membersDown('private');
		await expect(openAs(REMOVED)).rejects.toMatchObject({ status: 404 });
		expect(host.callsIn(ABOUT)).toEqual([ACCESS_READ]);
	});

	it('answers 503 when the visibility cannot be read either', async () => {
		membersDown(new Error('com.atproto.space.getRecord failed: 502'));
		await expect(openAs(REMOVED)).rejects.toMatchObject({ status: 503 });
	});

	it('shows a member a public group as a stranger sees it, and a form says why', async () => {
		membersDown('public');
		const data = await openAs(MEMBER);

		expect(data.membership).toMatchObject({ onRoster: false, role: 'member' });
		expect(data.membership.permissions.size).toBe(0);
		expect([data.canSeeMembers, data.canManageGroup, data.canAdmitMembers]).toEqual([
			false,
			false,
			false
		]);
		expect(notAllowed(data.membership, 'MANAGE_GROUP')).toMatchObject({
			reason: 'members-unreadable'
		});
	});
});

describe('a member whose sign-in reads no members space', () => {
	it('is told a new sign-in opens the members tab', async () => {
		groupHost('public');
		const data = await openAs(OWNER, { scope: META_ONLY });
		expect(data.membership).toMatchObject({ role: 'admin', signIn: true });
		expect(data.canSeeMembers).toBe(false);
	});

	it('hears nothing of a sign-in when the host itself turned them away', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		groupHost('public');
		admitOnly(GROUP_DID, (did, space) => did === OWNER || space === ABOUT);
		const data = await openAs(MEMBER);
		expect(data.canSeeMembers).toBe(false);
		expect(data.membership.signIn).toBeUndefined();
	});

	it('on a private group gets the notice in place of the 404, and nothing of the row', async () => {
		groupHost('private');
		expect(await openAs(OWNER, { scope: META_ONLY })).toStrictEqual({
			signInOnly: true,
			group: { group_did: GROUP_DID },
			groupName: GROUP_DID
		});
		await expect(openAs(STRANGER, { scope: META_ONLY })).rejects.toMatchObject({ status: 404 });
	});
});

describe('the link prompt', () => {
	const NO_LINK = { OAUTH_SESSIONS: { get: async () => null } as unknown as KVNamespace };
	const ADMIN = 'did:plc:admin';

	beforeEach(async () => {
		await addMember(harness.db, row.id, ADMIN, 'admin');
		groupHost('public', { roster: { ...ROSTER, [ADMIN]: 'admin' } });
	});

	it('asks anyone whose roles grant writes and who holds no session of their own to link one', async () => {
		for (const did of [ADMIN, OWNER]) {
			const data = await openAs(did, { env: NO_LINK });
			expect(data.groupLinked, did).toBe(false);
			expect(data.membership.onRoster).toBe(true);
		}
	});

	it("shows no prompt to whoever holds their own session, whatever anyone else's", async () => {
		const linked = linkGroups([GROUP_DID], undefined, [ADMIN]);
		expect((await openAs(ADMIN, { env: linked })).groupLinked).toBe(true);
		expect((await openAs(OWNER, { env: linked })).groupLinked).toBe(false);
	});

	it('answers null for anyone whose roles grant no writes', async () => {
		const linked = linkGroups([GROUP_DID]);
		for (const did of [MEMBER, STRANGER, null]) {
			expect((await openAs(did, { env: linked })).groupLinked, String(did)).toBeNull();
		}
	});
});

describe('a create whose setup stopped', () => {
	const STOPPED = 'did:plc:stoppedaaaaaaaaaaaaaaaaa';
	const pending = {
		by: OWNER,
		create: { name: 'Half made', visibility: 'private', joinPolicy: 'approval', listed: false }
	};
	const kv = {
		get: async (key: string) => (key === `group:setup:${STOPPED}` ? pending : null)
	} as unknown as KVNamespace;

	beforeEach(async () => {
		await seedGroup({
			harness,
			groupDid: STOPPED,
			creatorDid: OWNER,
			name: 'Half made',
			spaces: false
		});
	});

	it('offers its creator the rest of the setup, under the name they gave it', async () => {
		expect(await openAs(OWNER, { env: { OAUTH_SESSIONS: kv }, actor: STOPPED })).toStrictEqual({
			setupUnfinished: true,
			group: { group_did: STOPPED },
			groupName: 'Half made',
			error: null
		});
	});

	it('is the standard 404 to anyone else signed in', async () => {
		for (const did of [MEMBER, STRANGER]) {
			await expect(
				openAs(did, { env: { OAUTH_SESSIONS: kv }, actor: STOPPED }),
				String(did)
			).rejects.toMatchObject({ status: 404 });
		}
	});
});

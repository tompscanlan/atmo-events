import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the group page shows as the group's visibility: the badge and the
// settings form's selected value. It is the about space's access record, read
// from the host with the caller's own access, for every caller, including the
// owner, whom the gate itself never asks about. A signed-out visitor reads
// nothing and sees only the row and the declaration. The handle cache, the
// profile lookup and the resolver are stubbed because none of them decides
// anything here, and the space reader is a fake host whose access record each
// case sets. (Spec: FR-214; spec 003, Amendments 2026-10-15.)
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
import { authzRecords } from '$lib/groups/server/__fixtures__/members-space';
import {
	admitOnly,
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import { GROUP_NOT_FOUND, GROUP_VISIBILITY_UNCHECKED } from '$lib/groups/server/route-context';
import { linkGroups, unlinkAllGroups } from '$lib/groups/server/__fixtures__/linked-group';

import { ABOUT_SPACE_TYPE, type CallerMembership, type GroupVisibility } from '$lib/groups/types';
import { GROUP_PROFILE_COLLECTION, GROUP_RULE_COLLECTION } from '$lib/groups/about-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';

import { groupSpaceUris } from '$lib/groups/ids';
import { getGroupByDid } from '$lib/groups/server/db/groups';
import { addMember } from '$lib/groups/server/db/roster';
import { META_READ_GRANT } from '$lib/atproto/settings';
import { METADATA_CACHE_MS } from '$lib/groups/server/member-grants';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	resetReaderHost();
});

/** The read of the about space's access record, as the host logs it. */
const ACCESS_READ = `get ${ABOUT} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`;

/** The about space's access record saying `visibility`, as a create leaves it. */
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

/** Fails the read of the about space's access record with `error`, and nothing else. */
function accessReadFails(error: Error): (call: SpaceReadCall) => Error | undefined {
	return (call) =>
		call.method === 'get' && call.space === ABOUT && call.collection === GROUP_ACCESS_COLLECTION
			? error
			: undefined;
}

/** A host whose about space holds only an access record saying `visibility`, or
 *  fails its read with the error. No members space records means no authz
 *  config, so a roster caller's standing comes from the rows and the gate admits
 *  them without asking the host. */
function hostReading(visibility: GroupVisibility | Error): FakeSpaceReader {
	return visibility instanceof Error
		? spaceReader(GROUP_DID, { fail: accessReadFails(visibility) })
		: spaceReader(GROUP_DID, { records: [aboutAccess(visibility)] });
}

/** The reads of the about space's access record `host` was asked for, in order. */
function visibilityReads(host: FakeSpaceReader): string[] {
	return host.calls.filter((call) => call === ACCESS_READ);
}

/** Whom the host lets in, for a host with no membership records: `listed`
 *  on every space, and anyone on the about space unless the group is private.
 *  The rows then say who is on the roster, as they do when the members space
 *  holds no records. */
function listsHold(listed: readonly string[], visibility: GroupVisibility | Error) {
	admitOnly(
		GROUP_DID,
		(did, space) => listed.includes(did) || (space === ABOUT && visibility !== 'private')
	);
}

type GroupPage = {
	visibility: string | null;
	about: {
		name: string;
		joinPolicy: string;
		source: string;
		rules: { text: string; uri: string }[];
	};
	membership: CallerMembership;
	canSeeMembers: boolean;
	canManageGroup: boolean;
	canAdmitMembers: boolean;
	groupLinked: boolean | null;
	hiddenDetails: 'signed-out' | 'no-access' | null;
	rosterPreview: { did: string }[];
	ownerDid: string | null;
};

/** The page as `did` sees it, signed in with their own session
 *  (`readerSession`) unless the test hands one, or signed out. */
async function openAs(
	did: string | null,
	env: Record<string, unknown> = {},
	session?: unknown,
	actor: string = GROUP_DID
): Promise<GroupPage> {
	return (await load({
		params: { actor },
		locals: { did, session: session !== undefined ? session : did ? readerSession(did) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions, ...env } },
		url: new URL(`https://atmo.test/groups/${actor}`)
	} as unknown as Parameters<typeof load>[0])) as GroupPage;
}

/** The URLs the page sent, through the stubbed `fetch`. */
function sent(): string[] {
	return vi.mocked(globalThis.fetch).mock.calls.map(([input]) => String(input));
}

describe('/groups/[actor] load', () => {
	// The owner's page reads the record; a stranger's reuses the answer the gate
	// was given, so each reads it once. With no credential there is no host to
	// ask, and the page shows no visibility.
	it('the group page loads the visibility its access record says', async () => {
		for (const [did, visibility, joinPolicy] of [
			[OWNER, 'public', 'approval'],
			[OWNER, 'private', 'invite'],
			[STRANGER, 'public', 'approval']
		] as const) {
			const host = hostReading(visibility);
			serveReader(GROUP_DID, host);
			listsHold([OWNER, MEMBER], visibility);

			const data = await openAs(did);

			expect(data.visibility).toBe(visibility);
			expect(visibilityReads(host)).toEqual([ACCESS_READ]);
			// No profile record, so the join policy falls back to the row's
			// approval and the record's visibility.
			expect(data.about.joinPolicy).toBe(joinPolicy);
		}

		// An owner whose sign-in reads no spaces is shown no visibility, and why.
		const host = hostReading('public');
		serveReader(GROUP_DID, host);
		const blind = await openAs(OWNER, {}, readerSession(OWNER, 'atproto'));
		expect(blind.visibility).toBeNull();
		expect(blind.hiddenDetails).toBe('no-access');
		expect(host.calls).toEqual([]);
	});

	// The gate never asks the host about visibility for a member whose standing
	// it read, so a failed visibility read cannot lock them out; the page asks
	// only to show the visibility. When it cannot say, the page still renders,
	// with no visibility, and the join policy fails closed.
	it("a member's page loads with no visibility when the host cannot say", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const down = new Error('com.atproto.space.getRecord failed: 502');
		serveReader(GROUP_DID, hostReading(down));
		listsHold([OWNER, MEMBER], down);

		const data = await openAs(MEMBER);

		expect(data.visibility).toBeNull();
		expect(data.about.joinPolicy).toBe('invite');
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});
});

// The roster is members-only at every visibility, and the owner is on it, so a
// public group's page shows a caller off the roster neither the members' faces
// nor who owns it, and asks for no profile of either. The count stays: it is
// the rows', and a public group shows it to anyone.
describe('what a caller off the roster sees on a public group', () => {
	async function rosterShownTo(did: string | null) {
		const data = (await openAs(did)) as unknown as {
			rosterPreview: { did: string }[];
			ownerDid: string | null;
			memberCount: number;
		};
		const looked = vi.mocked(loadPeople).mock.calls.flatMap(([, dids]) => dids);
		return { ...data, looked };
	}

	beforeEach(() => {
		serveReader(GROUP_DID, hostReading('public'));
		listsHold([OWNER, MEMBER], 'public');
	});

	it('a member sees the faces and the owner', async () => {
		const shown = await rosterShownTo(MEMBER);

		expect(shown.ownerDid).toBe(OWNER);
		expect(shown.rosterPreview.map((entry) => entry.did)).toEqual(
			expect.arrayContaining([OWNER, MEMBER])
		);
		expect(shown.looked).toEqual(expect.arrayContaining([OWNER, MEMBER]));
	});

	it.each([
		['a signed-in stranger', STRANGER],
		['a signed-out caller', null]
	])('%s gets no faces, no owner, and no profile lookup of either', async (_, did) => {
		const shown = await rosterShownTo(did);

		expect(shown.rosterPreview).toEqual([]);
		expect(shown.ownerDid).toBeNull();
		expect(shown.looked).not.toContain(OWNER);
		expect(shown.looked).not.toContain(MEMBER);
		expect(shown.memberCount).toBe(2);
	});
});

// A caller whose membership cannot be read is not on the roster for a read,
// and the visibility gate decides for them as for any stranger. The window
// that matters is a members space that errors while the about space still
// answers: a host that is down as a whole fails the page anyway. REMOVED is a
// removal whose row delete failed, so a row still names them and no record
// does, and only the members space could have said which one to believe.
describe('a members space that cannot be read', () => {
	const REMOVED = 'did:plc:removed';
	const RECORD_DOWN = new Error('com.atproto.space.getRecord failed: 502');

	let logged: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		const row = (await getGroupByDid(harness.db, GROUP_DID))!;
		await addMember(harness.db, row.id, REMOVED, 'member');
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => logged.mockRestore());

	/** A host whose members space fails every read while its about space
	 *  answers with a private profile, and whose about space's access record
	 *  says `visibility`, or fails its read with the error. Its lists still hold
	 *  REMOVED, so their own access reaches the host and only the failed read
	 *  stands between the row and the group. */
	function membersDown(visibility: GroupVisibility | Error): FakeSpaceReader {
		listsHold([OWNER, MEMBER, REMOVED], visibility);
		const membersFail = hostDown(502, MEMBERS);
		const accessFail = visibility instanceof Error ? accessReadFails(visibility) : undefined;
		return spaceReader(GROUP_DID, {
			space: ABOUT,
			records: [
				{
					collection: 'group.opensocial.profile',
					rkey: 'self',
					value: { displayName: 'Members only', joinPolicy: 'invite' }
				},
				...(visibility instanceof Error ? [] : [aboutAccess(visibility)])
			],
			fail: (call) => membersFail(call) ?? accessFail?.(call)
		});
	}

	it('a stale row does not open a private group, and its profile is never read', async () => {
		const host = membersDown('private');
		serveReader(GROUP_DID, host);

		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
		// The about space's access record was read, and nothing else from it.
		expect(host.callsIn(ABOUT)).toEqual([ACCESS_READ]);
	});

	it('a stale row gets the 503 when the host cannot say the visibility either', async () => {
		serveReader(GROUP_DID, membersDown(RECORD_DOWN));

		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_VISIBILITY_UNCHECKED }
		});
	});

	// Members lose what only members see for as long as the space is down. The
	// row still names their role, which is display only, and a form that needs
	// a permission says it could not be checked rather than "Not allowed".
	it('a member reads a public group as a stranger does, and a form says why', async () => {
		const host = membersDown('public');
		serveReader(GROUP_DID, host);

		const data = await openAs(MEMBER);

		expect(data.visibility).toBe('public');
		expect(visibilityReads(host)).toEqual([ACCESS_READ]);
		expect(data.membership.onRoster).toBe(false);
		expect(data.membership.unreadable).toMatch(/failed: 502/);
		expect(data.membership.role).toBe('member');
		expect(data.membership.permissions.size).toBe(0);
		expect({
			canSeeMembers: data.canSeeMembers,
			canManageGroup: data.canManageGroup,
			canAdmitMembers: data.canAdmitMembers
		}).toEqual({
			canSeeMembers: false,
			canManageGroup: false,
			canAdmitMembers: false
		});
		expect(notAllowed(data.membership, 'MANAGE_GROUP')).toMatchObject({
			ok: false,
			reason: 'members-unreadable'
		});
	});

	it('a caller with no row gets the answers a stranger always got', async () => {
		serveReader(GROUP_DID, membersDown('private'));
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});

		serveReader(GROUP_DID, membersDown(RECORD_DOWN));
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_VISIBILITY_UNCHECKED }
		});

		serveReader(GROUP_DID, membersDown('public'));
		expect((await openAs(STRANGER)).visibility).toBe('public');
	});
});

// Right after a create, the creator's sign-in predates the group, so it carries
// no grant for the group's spaces and her own PDS refuses the members space. She
// sees what a non-member sees (TS 2026-10-15), and the page says when a new
// sign-in opens the members tab, since nothing else would tell her why her own
// group hides its members from her.
describe('a member whose sign-in predates the group', () => {
	/** A sign-in from before the group: every group's meta space and nothing else. */
	const BEFORE_THE_GROUP = `atproto ${META_READ_GRANT}`;

	it('tells the creator when a new sign-in opens the members tab', async () => {
		serveReader(GROUP_DID, hostReading('public'));
		listsHold([OWNER, MEMBER], 'public');
		const group = (await getGroupByDid(harness.db, GROUP_DID))!;

		const data = await openAs(OWNER, {}, readerSession(OWNER, BEFORE_THE_GROUP));

		expect(data.membership.role).toBe('owner');
		expect(data.canSeeMembers).toBe(false);
		expect(data.membership.signIn).toEqual({ from: group.created_at + METADATA_CACHE_MS });
	});

	it('says nothing of a sign-in to a member the host turned away', async () => {
		serveReader(GROUP_DID, hostReading('public'));
		listsHold([OWNER], 'public');
		vi.spyOn(console, 'error').mockImplementation(() => {});

		const data = await openAs(MEMBER);

		expect(data.canSeeMembers).toBe(false);
		expect(data.membership.signIn).toBeUndefined();
	});

	// A private group hides itself from anyone off the roster, so the gate
	// answered its own creator Group not found until the new sign-in.
	it('on a private group, tells the creator when a new sign-in opens it, in place of Group not found', async () => {
		serveReader(GROUP_DID, hostReading('private'));
		listsHold([OWNER, MEMBER], 'private');
		const group = (await getGroupByDid(harness.db, GROUP_DID))!;

		const data = (await openAs(OWNER, {}, readerSession(OWNER, BEFORE_THE_GROUP))) as unknown;

		expect(data).toEqual({
			signInOnly: true,
			group,
			groupName: 'Kona',
			signIn: { from: group.created_at + METADATA_CACHE_MS }
		});
	});

	it('on a private group, still answers someone the row does not list with Group not found', async () => {
		serveReader(GROUP_DID, hostReading('private'));
		listsHold([OWNER, MEMBER], 'private');

		await expect(
			openAs(STRANGER, {}, readerSession(STRANGER, BEFORE_THE_GROUP))
		).rejects.toMatchObject({ status: 404, body: { message: GROUP_NOT_FOUND } });
	});
});

// Until the owner links the group's account, every write as the group fails, so
// the page puts the link step in front of the owner, and only the owner: nobody
// else can link it. Reads never use the group's session, so an unlinked group's
// page is read with the caller's own access as any other is; a write refuses
// with the link step when it runs (`knownFormError`).
describe('the link prompt', () => {
	afterEach(() => unlinkAllGroups());

	/** A sessions store with no one's link in it. */
	const NO_LINK = { OAUTH_SESSIONS: { get: async () => null } as unknown as KVNamespace };
	const ADMIN = 'did:plc:admin';

	/** A public group whose members space holds the authz config: the owner and
	 *  an admin hold roles that grant writes, a member one that grants none. */
	async function withRoles(): Promise<FakeSpaceReader> {
		const row = await getGroupByDid(harness.db, GROUP_DID);
		await addMember(harness.db, row!.id, ADMIN, 'admin');
		const host = spaceReader(GROUP_DID, {
			records: [
				aboutAccess('public'),
				...authzRecords(GROUP_DID, { [OWNER]: 'owner', [ADMIN]: 'admin', [MEMBER]: 'member' })
			]
		});
		serveReader(GROUP_DID, host);
		listsHold([OWNER, ADMIN, MEMBER], 'public');
		return host;
	}

	// Anyone whose roles grant writes holds a group session of their own, not
	// only the owner (TS, 2026-10-15).
	it('asks an admin with no session of their own to link one, reading the page with their own access', async () => {
		const host = await withRoles();

		const data = await openAs(ADMIN, NO_LINK);

		expect(data.groupLinked).toBe(false);
		expect(data.visibility).toBe('public');
		expect(visibilityReads(host)).toEqual([ACCESS_READ]);
		expect(data.membership.onRoster).toBe(true);
		expect((await openAs(OWNER, NO_LINK)).groupLinked).toBe(false);
	});

	// Someone else's session is not theirs: the owner's prompt stays while only
	// the admin has linked.
	it('shows no prompt to a person who holds their own session, and only to them', async () => {
		await withRoles();
		const linked = linkGroups([GROUP_DID], undefined, [ADMIN]);

		expect((await openAs(ADMIN, linked)).groupLinked).toBe(true);
		expect((await openAs(OWNER, linked)).groupLinked).toBe(false);
	});

	it('answers null for anyone whose roles grant no writes, linked or not', async () => {
		await withRoles();
		expect((await openAs(MEMBER, NO_LINK)).groupLinked).toBeNull();

		const linked = linkGroups([GROUP_DID]);
		expect((await openAs(MEMBER, linked)).groupLinked).toBeNull();
		expect((await openAs(STRANGER, linked)).groupLinked).toBeNull();
		expect((await openAs(null, linked)).groupLinked).toBeNull();
	});
});

// Each person reads with their own access, and a visitor sees only what is
// public (TS 2026-10-15). A signed-out visitor has no access to read with, so
// the page shows the row and the public events, and says some details need a
// sign-in; a signed-in person reads the about space with a credential from
// their own session, which the group's host issues only where the group lets
// them in. (Spec 003, Amendments 2026-10-15.)
describe('what each caller reads with', () => {
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

	/** A host whose about space holds a profile, a rule and an access record
	 *  saying `visibility`, under the default rule: the host lets in whom its
	 *  records name. */
	function aboutHost(visibility: GroupVisibility): FakeSpaceReader {
		return spaceReader(GROUP_DID, { records: [aboutAccess(visibility), PROFILE, RULE] });
	}

	/** The load's refusal, as a status and body. */
	async function refusal(did: string | null, actor: string = GROUP_DID) {
		try {
			await openAs(did, {}, undefined, actor);
		} catch (e) {
			const { status, body } = e as { status: number; body: unknown };
			return { status, body };
		}
		throw new Error(`the page loaded for ${did} at ${actor}`);
	}

	it('a signed-out visitor reads nothing with anyone’s access, and sees only the row, no rules or roster, and the notice', async () => {
		const host = aboutHost('public');
		serveReader(GROUP_DID, host);

		const data = await openAs(null);

		// No space was read and no credential asked for, and the group's session
		// was never looked up.
		expect(host.calls).toEqual([]);
		expect(sent().filter((url) => /getDelegationToken|getSpaceCredential/.test(url))).toEqual([]);
		expect(fixtureSessions.reads).toBe(0);
		// Only what is public: the row's name, no rules, no faces, no owner.
		expect(data.about.source).toBe('cache');
		expect(data.about.name).toBe('Kona');
		expect(data.about.rules).toEqual([]);
		expect(data.rosterPreview).toEqual([]);
		expect(data.ownerDid).toBeNull();
		expect(data.visibility).toBe('public');
		expect(data.hiddenDetails).toBe('signed-out');
	});

	it('a private group answers a signed-out visitor and a signed-in non-member with the 404 a missing group gets', async () => {
		serveReader(GROUP_DID, aboutHost('private'));

		const missing = await refusal(STRANGER, 'did:plc:nosuchgroup');
		expect(missing).toStrictEqual({ status: 404, body: { message: GROUP_NOT_FOUND } });
		expect(await refusal(null)).toStrictEqual(missing);
		expect(await refusal(STRANGER)).toStrictEqual(missing);
	});

	it("a signed-in non-member reads a public group's profile and rules through a credential from their own session", async () => {
		const host = aboutHost('public');
		serveReader(GROUP_DID, host);

		const data = await openAs(STRANGER);

		expect(data.about.source).toBe('records');
		expect(data.about.name).toBe('Kona Paddlers');
		expect(data.about.rules.map((rule) => rule.text)).toEqual(['Wear a leash']);
		expect(data.hiddenDetails).toBeNull();
		// The about space's delegation token came from the stranger's own PDS, as
		// the stranger, and the group's session was never looked up.
		const asked = vi
			.mocked(globalThis.fetch)
			.mock.calls.filter(([input]) => String(input).includes('getDelegationToken'))
			.map(([input, init]) => ({
				space: new URL(String(input)).searchParams.get('space'),
				as: new Headers(init?.headers).get('authorization')
			}));
		expect(asked).toContainEqual({ space: ABOUT, as: `Bearer member ${STRANGER}` });
		expect(asked.every((request) => request.as === `Bearer member ${STRANGER}`)).toBe(true);
		expect(fixtureSessions.reads).toBe(0);
		// Not let into the members space, so they stand as a non-member, which is
		// an answer, not a failure.
		expect(data.membership.onRoster).toBe(false);
		expect(data.membership.unreadable).toBeUndefined();
	});
});

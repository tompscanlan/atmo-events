import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the group page shows as the group's visibility: the badge and the
// settings form's selected value. It is the about space's access record, read
// from the host, for every caller, including the owner, whom the gate itself
// never asks about. The handle cache, the profile lookup and the resolver are
// stubbed because none of them decides anything here, and the space reader is a
// fake host whose access record each case sets. (Spec: FR-214.)
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
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import { GROUP_NOT_FOUND, GROUP_VISIBILITY_UNCHECKED } from '$lib/groups/server/route-context';
import { linkGroups, unlinkAllGroups } from '$lib/groups/server/__fixtures__/linked-group';

import { ABOUT_SPACE_TYPE, type CallerMembership, type GroupVisibility } from '$lib/groups/types';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';

import { groupSpaceUris } from '$lib/groups/ids';
import { getGroupByDid } from '$lib/groups/server/db/groups';
import { addMember } from '$lib/groups/server/db/roster';
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

async function openAs(did: string | null, env: Record<string, unknown> = {}) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions, ...env } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}`)
	} as unknown as Parameters<typeof load>[0])) as {
		visibility: string | null;
		about: { name: string; joinPolicy: string };
		membership: CallerMembership;
		canSeeMembers: boolean;
		canManageGroup: boolean;
		canAdmitMembers: boolean;
		groupLinked: boolean | null;
	};
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

			const data = await openAs(did);

			expect(data.visibility).toBe(visibility);
			expect(visibilityReads(host)).toEqual([ACCESS_READ]);
			// No profile record, so the join policy falls back to the row's
			// approval and the record's visibility.
			expect(data.about.joinPolicy).toBe(joinPolicy);
		}

		serveReader(GROUP_DID, null);
		expect((await openAs(OWNER)).visibility).toBeNull();
	});

	// The gate never asks the host about visibility for a member whose standing
	// it read, so a failed visibility read cannot lock them out; the page asks
	// only to show the visibility. When it cannot say, the page still renders,
	// with no visibility, and the join policy fails closed.
	it("a member's page loads with no visibility when the host cannot say", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		serveReader(GROUP_DID, hostReading(new Error('com.atproto.space.getRecord failed: 502')));

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

	beforeEach(() => serveReader(GROUP_DID, hostReading('public')));

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
	 *  says `visibility`, or fails its read with the error. */
	function membersDown(visibility: GroupVisibility | Error): FakeSpaceReader {
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
		expect(notAllowed(data.membership, 'MANAGE_GROUP')).toEqual({
			ok: false,
			error: expect.stringContaining('could not be checked')
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

// Until the owner links the group's account, every write as the group fails, so
// the page puts the link step in front of the owner, and only the owner: nobody
// else can link it. Unlinked, the deployment holds no session to read the
// group's spaces with, so the host here has no reader either.
describe('the link prompt', () => {
	afterEach(() => unlinkAllGroups());

	it('asks the owner to link a group whose account is not linked, and the forms say the same', async () => {
		serveReader(GROUP_DID, null);

		const data = await openAs(OWNER, linkGroups([]));

		expect(data.groupLinked).toBe(false);
		// The settings stay hidden, and a form posted anyway names the same fix.
		expect(data.canManageGroup).toBe(false);
		expect(notAllowed(data.membership, 'MANAGE_GROUP').error).toMatch(
			/owner has to link the group’s account/
		);
	});

	it('shows the owner of a linked group no prompt', async () => {
		serveReader(GROUP_DID, hostReading('public'));

		const data = await openAs(OWNER, linkGroups([GROUP_DID]));

		expect(data.groupLinked).toBe(true);
	});

	it('answers null for everyone but the owner, linked or not', async () => {
		serveReader(GROUP_DID, null);
		expect((await openAs(MEMBER, linkGroups([]))).groupLinked).toBeNull();

		serveReader(GROUP_DID, hostReading('public'));
		const linked = linkGroups([GROUP_DID]);
		expect((await openAs(MEMBER, linked)).groupLinked).toBeNull();
		expect((await openAs(STRANGER, linked)).groupLinked).toBeNull();
		expect((await openAs(null, linked)).groupLinked).toBeNull();
	});
});

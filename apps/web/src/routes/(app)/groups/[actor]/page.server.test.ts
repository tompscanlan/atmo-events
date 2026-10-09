import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the group page shows as the group's visibility: the badge and the
// settings form's selected value. It is the host's answer, the about space's
// read policy, for every caller, including the owner, whom the gate itself
// never asks about. The handle cache, the profile lookup and the resolver are
// stubbed because none of them decides anything here, and the space reader is a
// fake host whose read policy each case sets.
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
import { notAllowed } from '$lib/groups/form-error';
import {
	hostDown,
	spaceReader,
	type FakeSpaceReader
} from '$lib/groups/server/__fixtures__/space-reader';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';

import {
	GROUP_NOT_FOUND,
	GROUP_VISIBILITY_UNCHECKED,
	groupRouteContext
} from '$lib/groups/server/route-context';
import { linkGroups, unlinkAllGroups } from '$lib/groups/server/__fixtures__/linked-group';

import type { CallerMembership } from '$lib/groups/types';

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

/** A host whose spaces hold no records and whose about space reports
 *  `readPolicy`, or fails with it. No records means no authz config, so a
 *  roster caller's standing comes from the rows and the gate admits them
 *  without asking the host. */
function hostReading(readPolicy: string | Error): FakeSpaceReader {
	return spaceReader(GROUP_DID, { policies: { [ABOUT]: readPolicy } });
}

/** The read policies `host` was asked for, in order. */
function policyReads(host: FakeSpaceReader): string[] {
	return host.calls.filter((call) => call.startsWith('getSpace '));
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
	it('the group page loads the visibility its host reports', async () => {
		for (const [policy, visibility, joinPolicy] of [
			['com.atproto.simplespace.defs#publicPolicy', 'public', 'approval'],
			['com.atproto.simplespace.defs#memberListPolicy', 'private', 'invite']
		] as const) {
			const host = hostReading(policy);
			serveReader(GROUP_DID, host);

			const data = await openAs(OWNER);

			expect(data.visibility).toBe(visibility);
			expect(policyReads(host)).toEqual([`getSpace ${ABOUT}`]);
			// No profile record, so the join policy falls back to the row's
			// approval and the host's visibility.
			expect(data.about.joinPolicy).toBe(joinPolicy);
		}
	});

	// A caller off the roster was already gated on the host's answer, so the
	// page shows that one and does not ask again.
	it("a stranger's page reuses the gate's answer and asks the host once", async () => {
		const host = hostReading('com.atproto.simplespace.defs#publicPolicy');
		serveReader(GROUP_DID, host);

		const data = await openAs(STRANGER);

		expect(data.visibility).toBe('public');
		expect(policyReads(host)).toEqual([`getSpace ${ABOUT}`]);
	});

	// The gate never asks the host about visibility for a member whose standing
	// it read, so a failed visibility read cannot lock them out; the page asks
	// only to show the visibility. When it cannot say, the page still renders,
	// with no visibility, and the join policy fails closed.
	it("a member's page loads with no visibility when the host cannot say", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		serveReader(GROUP_DID, hostReading(new Error('getSpace failed: 502')));

		const data = await openAs(MEMBER);

		expect(data.visibility).toBeNull();
		expect(data.about.joinPolicy).toBe('invite');
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	it("an owner's page loads with no visibility when the deployment holds no credential", async () => {
		serveReader(GROUP_DID, null);

		const data = await openAs(OWNER);

		expect(data.visibility).toBeNull();
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
	const PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';
	const PRIVATE = 'com.atproto.simplespace.defs#memberListPolicy';

	let logged: ReturnType<typeof vi.spyOn>;

	beforeEach(async () => {
		const row = (await getGroupByDid(harness.db, GROUP_DID))!;
		await addMember(harness.db, row.id, REMOVED, 'member');
		logged = vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	afterEach(() => logged.mockRestore());

	/** A host whose members space fails every read while its about space
	 *  answers with a private profile, and whose about space reports
	 *  `readPolicy`, or fails with it. */
	function membersDown(readPolicy: string | Error): FakeSpaceReader {
		return spaceReader(GROUP_DID, {
			space: ABOUT,
			records: [
				{
					collection: 'group.opensocial.profile',
					rkey: 'self',
					value: { displayName: 'Members only', joinPolicy: 'invite' }
				}
			],
			policies: { [ABOUT]: readPolicy },
			fail: hostDown(502, MEMBERS)
		});
	}

	it('a stale row does not open a private group, and its profile is never read', async () => {
		const host = membersDown(PRIVATE);
		serveReader(GROUP_DID, host);

		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
		// The about space was asked its policy, and nothing was read from it.
		expect(host.callsIn(ABOUT)).toEqual([`getSpace ${ABOUT}`]);
	});

	// The events tab, the members page and every group form take their context
	// from the same call, so they refuse the stale row with the page's 404.
	it('the route context the tabs and forms share refuses the stale row the same way', async () => {
		serveReader(GROUP_DID, membersDown(PRIVATE));

		await expect(
			groupRouteContext({ OAUTH_SESSIONS: fixtureSessions }, harness.db, GROUP_DID, REMOVED)
		).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});
	});

	it('a stale row gets the 503 when the host cannot say the visibility either', async () => {
		serveReader(GROUP_DID, membersDown(new Error('getSpace failed: 502')));

		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_VISIBILITY_UNCHECKED }
		});
	});

	// Members lose what only members see for as long as the space is down. The
	// row still names their role, which is display only, and a form that needs
	// a permission says it could not be checked rather than "Not allowed".
	it('a member reads a public group as a stranger does, and a form says why', async () => {
		const host = membersDown(PUBLIC);
		serveReader(GROUP_DID, host);

		const data = await openAs(MEMBER);

		expect(data.visibility).toBe('public');
		expect(policyReads(host)).toEqual([`getSpace ${ABOUT}`]);
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
		serveReader(GROUP_DID, membersDown(PRIVATE));
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 404,
			body: { message: GROUP_NOT_FOUND }
		});

		serveReader(GROUP_DID, membersDown(new Error('getSpace failed: 502')));
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 503,
			body: { message: GROUP_VISIBILITY_UNCHECKED }
		});

		serveReader(GROUP_DID, membersDown(PUBLIC));
		expect((await openAs(STRANGER)).visibility).toBe('public');
	});
});

// Until the owner links the group's account, every write as the group fails, so
// the page puts the link step in front of the owner, and only the owner: nobody
// else can link it. Unlinked, the deployment holds no session to read the
// group's spaces with, so the host here has no reader either.
describe('the link prompt', () => {
	const PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';

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
		serveReader(GROUP_DID, hostReading(PUBLIC));

		const data = await openAs(OWNER, linkGroups([GROUP_DID]));

		expect(data.groupLinked).toBe(true);
	});

	it('answers null for everyone but the owner, linked or not', async () => {
		serveReader(GROUP_DID, null);
		expect((await openAs(MEMBER, linkGroups([]))).groupLinked).toBeNull();

		serveReader(GROUP_DID, hostReading(PUBLIC));
		const linked = linkGroups([GROUP_DID]);
		expect((await openAs(MEMBER, linked)).groupLinked).toBeNull();
		expect((await openAs(STRANGER, linked)).groupLinked).toBeNull();
		expect((await openAs(null, linked)).groupLinked).toBeNull();
	});
});

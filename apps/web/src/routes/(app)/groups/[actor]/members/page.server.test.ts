import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The roster is members-only at every visibility, public included, so the
// members page refuses everyone off it with a 403, even on a group whose page
// anyone may open, and before anything is read with their access. When the
// members space holds membership records, they decide: a row the records do not
// back (a removal whose row delete failed) opens nothing. With no records, the
// rows decide. Every read is the caller's own. The profile
// lookup and the resolver are stubbed because neither decides anything here,
// and the host is a fake whose spaces each case sets.
vi.mock('$lib/groups/server/people', () => ({ loadPeople: vi.fn(async () => ({})) }));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { membersSpaceReader } from '$lib/groups/server/__fixtures__/members-space';
import {
	admitOnly,
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import {
	spaceReader,
	type FakeSpaceReader,
	type SpaceRecordInput
} from '$lib/groups/server/__fixtures__/space-reader';
import { groupSpaceUris } from '$lib/groups/ids';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCEPTANCE_COLLECTION,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';
import { ABOUT_SPACE_TYPE } from '$lib/groups/types';
import { META_READ_GRANT } from '$lib/atproto/settings';
import { METADATA_CACHE_MS } from '$lib/groups/server/member-grants';
import { getGroupByDid } from '$lib/groups/server/db/groups';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
/** On the rows, but the records no longer name them. */
const REMOVED = 'did:plc:removed';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);
/** The about space's access record saying public, as a create leaves it: the
 *  group's visibility. (Spec: FR-214.) */
const PUBLIC_ACCESS: SpaceRecordInput = {
	space: ABOUT,
	collection: GROUP_ACCESS_COLLECTION,
	rkey: GROUP_ACCESS_RKEY,
	value: {
		...groupAccessRecord({
			spaceType: ABOUT_SPACE_TYPE,
			roles: ABOUT_SPACE_READER_ROLES,
			public: true
		}),
		$type: GROUP_ACCESS_COLLECTION
	}
};

/** `host`, holding the public about space's access record too. */
function asPublic(host: FakeSpaceReader): FakeSpaceReader {
	host.put(PUBLIC_ACCESS);
	return host;
}

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member', [REMOVED]: 'member' }
	}));
	// A read the host refuses is logged; no case here should depend on it.
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
	resetReaderHost();
});

/** The page as `did` sees it, signed in with their own session (`readerSession`)
 *  unless the test hands one, or signed out. */
async function openAs(did: string | null, session?: unknown) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did, session: session ?? (did ? readerSession(did) : null) },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as {
		members: { did: string }[];
		rosterSource: 'records' | 'cache';
		canEjectMembers: boolean;
		unfinished: string[];
		signIn?: { from: number | null };
	};
}

describe('/groups/[actor]/members load, with membership records', () => {
	// A public group, so every caller passes the group gate and the members
	// page's own gate is the only thing between them and the roster. The host
	// lets into the members space whom its records name.
	let host: FakeSpaceReader;
	beforeEach(() => {
		host = asPublic(membersSpaceReader(MEMBERS, GROUP_DID, [MEMBER]));
		serveReader(GROUP_DID, host);
	});

	it('shows a member the roster the records hold', async () => {
		const data = await openAs(MEMBER);

		expect(data.rosterSource).toBe('records');
		expect(data.members.map((entry) => entry.did)).toEqual([MEMBER]);
	});

	it('refuses a signed-in stranger with a 403, and reads nothing of the members space for them', async () => {
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Only members can see this roster' }
		});
		expect(host.callsIn(MEMBERS)).toEqual([]);
	});

	it("reads the roster and each confirmation with the viewer's own credential, never the group's session", async () => {
		await openAs(MEMBER);

		const sent = vi.mocked(globalThis.fetch).mock.calls.map(([input, init]) => ({
			url: new URL(String(input)),
			as: new Headers(init?.headers).get('authorization') ?? ''
		}));
		const delegations = sent.filter(({ url }) => url.pathname.endsWith('getDelegationToken'));
		expect(delegations.map(({ url }) => url.searchParams.get('space'))).toContain(MEMBERS);
		expect(delegations.every(({ as }) => as === `Bearer member ${MEMBER}`)).toBe(true);
		const confirmations = sent.filter(
			({ url }) => url.searchParams.get('collection') === GROUP_ACCEPTANCE_COLLECTION
		);
		expect(confirmations.map(({ url }) => url.searchParams.get('repo'))).toEqual([MEMBER]);
		expect(confirmations.every(({ as }) => as.startsWith('Atproto-Space-Credential '))).toBe(true);
		expect(fixtureSessions.reads).toBe(0);
	});

	it('shows the group account the roster, though no record names it (FR-213)', async () => {
		const data = await openAs(GROUP_DID);

		expect(data.members.map((entry) => entry.did)).toEqual([MEMBER]);
		expect(data.canEjectMembers).toBe(true);
	});

	it('lists a row the records do not back as not finished, for whoever may eject', async () => {
		const data = await openAs(GROUP_DID);

		// The creator's row has no record in this fixture either. With no owner
		// it is a row like any other, so it is listed too.
		expect(data.unfinished).toEqual([OWNER, REMOVED]);
		expect(data.members.map((entry) => entry.did)).not.toContain(REMOVED);
	});

	it('lists nothing as not finished to a member who may not eject', async () => {
		const data = await openAs(MEMBER);

		expect(data.unfinished).toEqual([]);
	});

	it('refuses a row the records do not back, as it refuses a stranger', async () => {
		await expect(openAs(REMOVED)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Only members can see this roster' }
		});
	});

	it('asks a signed-out caller to sign in', async () => {
		await expect(openAs(null)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Sign in to see members' }
		});
	});
});

describe('/groups/[actor]/members load, with no membership records', () => {
	// The members space was never written, so the rows are the roster, and the
	// host's lists hold whom the rows name.
	beforeEach(() => {
		serveReader(GROUP_DID, spaceReader(GROUP_DID, { records: [PUBLIC_ACCESS] }));
		const listed = [GROUP_DID, OWNER, MEMBER, REMOVED];
		admitOnly(GROUP_DID, (did, space) => listed.includes(did) || space === ABOUT);
	});

	it('shows a member on the rows the roster', async () => {
		const data = await openAs(MEMBER);

		expect(data.rosterSource).toBe('cache');
		expect(data.members.map((entry) => entry.did)).toContain(MEMBER);
	});

	it('lists nothing as not finished, since the rows are the roster', async () => {
		const data = await openAs(GROUP_DID);

		expect(data.unfinished).toEqual([]);
	});

	it('shows the group account the roster, though no row names it', async () => {
		const data = await openAs(GROUP_DID);

		expect(data.members.map((entry) => entry.did)).toContain(MEMBER);
	});

	it('refuses a signed-in stranger with a 403', async () => {
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Only members can see this roster' }
		});
	});

	it('asks a signed-out caller to sign in', async () => {
		await expect(openAs(null)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Sign in to see members' }
		});
	});
});

// Right after a create, the creator's sign-in predates the group, so it carries
// no grant for the group's spaces: her own PDS refuses the members space, and
// she stands off the roster. The grant can be asked for once
// every PDS's copy of this site's client metadata names the group, so the page
// says when a new sign-in opens the roster, rather than refusing her.
describe('/groups/[actor]/members load, for a member whose sign-in predates the group', () => {
	/** A sign-in from before the group: it reads every group's meta space and
	 *  nothing else. */
	const BEFORE_THE_GROUP = `atproto ${META_READ_GRANT}`;

	let host: FakeSpaceReader;
	beforeEach(() => {
		host = asPublic(membersSpaceReader(MEMBERS, GROUP_DID, [OWNER, MEMBER]));
		serveReader(GROUP_DID, host);
	});

	it('tells the creator when a new sign-in shows her the roster, and reads none of it', async () => {
		const group = (await getGroupByDid(harness.db, GROUP_DID))!;

		const data = await openAs(OWNER, readerSession(OWNER, BEFORE_THE_GROUP));

		expect(data.signIn).toEqual({ from: group.created_at + METADATA_CACHE_MS });
		expect(data.members).toBeUndefined();
		expect(host.callsIn(MEMBERS)).toEqual([]);
	});

	it('names no time once the wait is over', async () => {
		await harness.db
			.prepare(`UPDATE groups SET created_at = ? WHERE group_did = ?`)
			.bind(Date.now() - METADATA_CACHE_MS - 1, GROUP_DID)
			.run();

		const data = await openAs(MEMBER, readerSession(MEMBER, BEFORE_THE_GROUP));

		expect(data.signIn).toEqual({ from: null });
	});

	it('refuses a stranger as before, whatever their sign-in carries', async () => {
		await expect(openAs(STRANGER, readerSession(STRANGER, BEFORE_THE_GROUP))).rejects.toMatchObject(
			{ status: 403, body: { message: 'Only members can see this roster' } }
		);
	});

	// A private group hides itself from anyone off the roster, and right after the
	// create its creator is off it, so the gate answered her Group not found.
	describe('on a private group', () => {
		beforeEach(() => {
			host = membersSpaceReader(MEMBERS, GROUP_DID, [OWNER, MEMBER]);
			host.put({
				...PUBLIC_ACCESS,
				value: { ...PUBLIC_ACCESS.value, public: false }
			});
			serveReader(GROUP_DID, host);
		});

		it('tells the creator the same instead of Group not found, and reads none of the roster', async () => {
			const group = (await getGroupByDid(harness.db, GROUP_DID))!;

			const data = await openAs(OWNER, readerSession(OWNER, BEFORE_THE_GROUP));

			expect(data.signIn).toEqual({ from: group.created_at + METADATA_CACHE_MS });
			expect(data.members).toBeUndefined();
			expect(host.callsIn(MEMBERS)).toEqual([]);
		});

		it('still answers a stranger with Group not found, whatever their sign-in carries', async () => {
			await expect(
				openAs(STRANGER, readerSession(STRANGER, BEFORE_THE_GROUP))
			).rejects.toMatchObject({ status: 404, body: { message: 'Group not found' } });
		});
	});
});

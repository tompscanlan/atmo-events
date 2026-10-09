import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The roster is members-only at every visibility, public included, so the
// members page refuses everyone off it with a 403, even on a group whose page
// anyone may open. When the members space holds membership records, they
// decide: a row the records do not back (a removal whose row delete failed)
// opens nothing. With no records, the rows decide. The profile lookup and the
// resolver are stubbed because neither decides anything here, and the host is
// a fake whose spaces each case sets.
vi.mock('$lib/groups/server/people', () => ({ loadPeople: vi.fn(async () => ({})) }));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { membersSpaceReader } from '$lib/groups/server/__fixtures__/members-space';
import {
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import { spaceReader } from '$lib/groups/server/__fixtures__/space-reader';
import { groupSpaceUris } from '$lib/groups/ids';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
/** On the rows, but the records no longer name them. */
const REMOVED = 'did:plc:removed';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);
const PUBLIC = 'com.atproto.simplespace.defs#publicPolicy';

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member', [REMOVED]: 'member' }
	}));
	// A member's page reads acceptances through a credential this harness does
	// not hold, and logs that it could not.
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
	resetReaderHost();
});

async function openAs(did: string | null) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as {
		members: { did: string }[];
		rosterSource: 'records' | 'cache';
	};
}

describe('/groups/[actor]/members load, with membership records', () => {
	// A public group, so every caller passes the group gate and the members
	// page's own gate is the only thing between them and the roster.
	beforeEach(() => {
		serveReader(GROUP_DID, membersSpaceReader(MEMBERS, GROUP_DID, [MEMBER], { [ABOUT]: PUBLIC }));
	});

	it('shows a member the roster the records hold', async () => {
		const data = await openAs(MEMBER);

		expect(data.rosterSource).toBe('records');
		expect(data.members.map((entry) => entry.did)).toEqual([MEMBER]);
	});

	it('refuses a signed-in stranger with a 403', async () => {
		await expect(openAs(STRANGER)).rejects.toMatchObject({
			status: 403,
			body: { message: 'Only members can see this roster' }
		});
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
	// The members space was never written, so the rows are the roster.
	beforeEach(() => {
		serveReader(GROUP_DID, spaceReader(GROUP_DID, { policies: { [ABOUT]: PUBLIC } }));
	});

	it('shows a member on the rows the roster', async () => {
		const data = await openAs(MEMBER);

		expect(data.rosterSource).toBe('cache');
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

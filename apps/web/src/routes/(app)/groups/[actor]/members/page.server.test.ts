import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/groups/server/people', () => ({ loadPeople: vi.fn(async () => ({})) }));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { authzReader } from '$lib/groups/server/__fixtures__/members-space';
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
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';
import { ABOUT_SPACE_TYPE } from '$lib/groups/types';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
/** On the rows, but the records no longer name them. */
const REMOVED = 'did:plc:removed';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);
const META_ONLY = 'atproto space:group.opensocial.meta?authority=*&action=read';

const metaAccess = (isPublic: boolean): SpaceRecordInput => ({
	space: ABOUT,
	collection: GROUP_ACCESS_COLLECTION,
	rkey: GROUP_ACCESS_RKEY,
	value: {
		...groupAccessRecord({
			spaceType: ABOUT_SPACE_TYPE,
			roles: ABOUT_SPACE_READER_ROLES,
			public: isPublic
		}),
		$type: GROUP_ACCESS_COLLECTION
	}
});

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member', [REMOVED]: 'member' }
	}));
	vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
	resetReaderHost();
});

/** A host whose members space names OWNER as admin and MEMBER as member. */
function recordsHost(isPublic = true): FakeSpaceReader {
	const host = authzReader(
		GROUP_DID,
		{ [OWNER]: 'admin', [MEMBER]: 'member' },
		{ records: [metaAccess(isPublic)] }
	);
	serveReader(GROUP_DID, host);
	return host;
}

async function openAs(did: string | null, scope?: string) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did, session: did ? readerSession(did, scope) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown> & {
		members: { did: string; role: string }[];
		unfinished: string[];
		rolePermissions: Record<string, string[]>;
	};
}

const dids = (data: { members: { did: string }[] }) => data.members.map((entry) => entry.did);

describe('/groups/[actor]/members load, with membership records', () => {
	it("shows a member the records' roster, read with their own credential alone", async () => {
		recordsHost();
		const data = await openAs(MEMBER);

		expect(data.members.map(({ did, role }) => [did, role]).sort()).toEqual([
			[MEMBER, 'member'],
			[OWNER, 'admin']
		]);
		expect(Object.keys(data.members[0]).sort()).toEqual(['created_at', 'did', 'role']);
		expect(data.rolePermissions.member).toEqual([]);
		expect(data.rolePermissions.admin).toContain('ADMIT_MEMBERS');
		expect(data.unfinished).toEqual([]);
		const delegations = vi
			.mocked(globalThis.fetch)
			.mock.calls.filter(([input]) => String(input).includes('getDelegationToken'))
			.map(([, init]) => new Headers(init?.headers).get('authorization'));
		expect(new Set(delegations)).toEqual(new Set([`Bearer member ${MEMBER}`]));
		expect(fixtureSessions.reads).toBe(0);
	});

	it('lists the rows the records do not back as not finished, to whoever may eject', async () => {
		recordsHost();
		const data = await openAs(OWNER);

		expect(data.unfinished).toEqual([REMOVED]);
		expect(dids(data)).not.toContain(REMOVED);
	});

	it.each([
		['a signed-in stranger', STRANGER],
		['a row the records do not back', REMOVED],
		['a signed-out caller', null]
	])('refuses %s with a 403, reading nothing of the members space for them', async (_, did) => {
		const host = recordsHost();
		await expect(openAs(did)).rejects.toMatchObject({ status: 403 });
		if (did !== REMOVED) expect(host.callsIn(MEMBERS)).toEqual([]);
	});
});

describe('/groups/[actor]/members load, with no membership records', () => {
	beforeEach(() => {
		serveReader(GROUP_DID, spaceReader(GROUP_DID, { records: [metaAccess(true)] }));
		const listed = [GROUP_DID, OWNER, MEMBER, REMOVED];
		admitOnly(GROUP_DID, (did, space) => listed.includes(did) || space === ABOUT);
	});

	it('shows the rows as the roster, with nothing unfinished', async () => {
		const data = await openAs(GROUP_DID);
		expect(dids(data).sort()).toEqual([MEMBER, OWNER, REMOVED].sort());
		expect(data.unfinished).toEqual([]);
	});

	it('refuses a signed-in stranger with a 403', async () => {
		await expect(openAs(STRANGER)).rejects.toMatchObject({ status: 403 });
	});
});

describe('/groups/[actor]/members load, for a member whose sign-in reads no members space', () => {
	it.each([
		['public', true],
		['private', false]
	])(
		'on a %s group, says a new sign-in opens the roster, and reads none of it',
		async (_, isPublic) => {
			const host = recordsHost(isPublic);
			const data = await openAs(OWNER, META_ONLY);

			expect(data).toMatchObject({ signIn: true });
			expect(data.members).toBeUndefined();
			expect(host.callsIn(MEMBERS)).toEqual([]);
		}
	);

	it('refuses a stranger as before: 403 on a public group, 404 on a private one', async () => {
		recordsHost(true);
		await expect(openAs(STRANGER, META_ONLY)).rejects.toMatchObject({ status: 403 });
		resetReaderHost();
		recordsHost(false);
		await expect(openAs(STRANGER, META_ONLY)).rejects.toMatchObject({ status: 404 });
	});
});

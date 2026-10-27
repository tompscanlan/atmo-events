import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { groupEventHost, PRIVATE_GROUP } from './event-host';
import {
	spaceReader,
	type SpaceReadCall,
	type SpaceRecordInput
} from './__fixtures__/space-reader';
import { authzRecords } from './__fixtures__/host-records';
import {
	admitOnly,
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from './__fixtures__/reader-host';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { registerGroupIdentity } from './identities';
import { GROUP_PROFILE_COLLECTION } from '../about-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '../members-record';
import { groupSpaceUris } from '../ids';
import { ABOUT_SPACE_TYPE, type GroupVisibility } from '../types';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const PERSON = 'did:plc:person';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const HANDLE = 'kona.group.stub.test';
const GROUP_PAGE = `/groups/${GROUP_DID}`;
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
const PROFILE: SpaceRecordInput = {
	space: ABOUT,
	collection: GROUP_PROFILE_COLLECTION,
	rkey: 'self',
	value: { displayName: 'Kona Paddlers', joinPolicy: 'approval' }
};

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	harness.raw.exec(
		'CREATE TABLE identities (did TEXT PRIMARY KEY, handle TEXT, pds TEXT, resolved_at INTEGER)'
	);
	await registerGroupIdentity(harness.db, { did: GROUP_DID, handle: HANDLE, pds: null });
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
	resetReaderHost();
});

/** The group's host: its roster, and a meta space whose access says `visibility`, or whose
 *  access read fails with the error. */
function groupHost(visibility: GroupVisibility | Error) {
	const held = [...authzRecords(GROUP_DID, { [OWNER]: 'admin', [MEMBER]: 'member' }), PROFILE];
	const access: SpaceRecordInput = {
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
	const host =
		visibility instanceof Error
			? spaceReader(GROUP_DID, {
					records: held,
					fail: (call: SpaceReadCall) =>
						call.collection === GROUP_ACCESS_COLLECTION ? visibility : undefined
				})
			: spaceReader(GROUP_DID, { records: [access, ...held] });
	serveReader(GROUP_DID, host);
	return host;
}

function hostFor(
	viewer: string | null,
	{ author = GROUP_DID, groups = true }: { author?: string; groups?: boolean } = {}
) {
	const env = {
		DB: harness.db,
		OAUTH_SESSIONS: fixtureSessions,
		...(groups ? { GROUP_HOST_URL: 'https://group-host.stub.test' } : {})
	} as unknown as App.Platform['env'];
	return groupEventHost(env, author, {
		did: viewer as App.Locals['did'],
		session: viewer ? readerSession(viewer) : null
	});
}

describe("a public event's host line", () => {
	it("keeps the account's own line for an author who is no group here, and reads no space", async () => {
		const host = groupHost('public');
		expect(await hostFor(STRANGER, { author: PERSON })).toBeNull();
		expect(host.calls).toEqual([]);
	});

	it('keeps it on a site with no group host', async () => {
		const host = groupHost('public');
		expect(await hostFor(STRANGER, { groups: false })).toBeNull();
		expect(host.calls).toEqual([]);
	});

	it('names a public group and links its page, for a visitor and a signed-in stranger', async () => {
		groupHost('public');
		expect(await hostFor(null)).toEqual({ name: 'Kona', href: GROUP_PAGE });
		expect(await hostFor(STRANGER)).toEqual({ name: 'Kona Paddlers', href: GROUP_PAGE });
	});

	it('shows anyone off a private group its handle and the words, with no name and no link', async () => {
		groupHost('private');
		const hidden = { name: HANDLE, href: null, note: PRIVATE_GROUP };
		expect(await hostFor(null)).toEqual(hidden);
		expect(await hostFor(STRANGER)).toEqual(hidden);
	});

	it('names a private group and links its page for a member', async () => {
		groupHost('private');
		expect(await hostFor(MEMBER)).toEqual({ name: 'Kona Paddlers', href: GROUP_PAGE });
	});

	it("keeps the account's own line when the host cannot say whether the group is private", async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		groupHost(new Error('com.atproto.space.getRecord failed: 502'));
		admitOnly(GROUP_DID, () => true);
		expect(await hostFor(STRANGER)).toBeNull();
	});
});

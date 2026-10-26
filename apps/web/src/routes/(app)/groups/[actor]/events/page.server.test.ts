import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/groups/server/events-index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/events-index')>()),
	listGroupEvents: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { authzReader } from '$lib/groups/server/__fixtures__/members-space';
import type {
	SpaceReaderOptions,
	SpaceRecordInput
} from '$lib/groups/server/__fixtures__/space-reader';
import {
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { listGroupEvents } from '$lib/groups/server/events-index';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import { groupSpaceUris } from '$lib/groups/ids';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '$lib/groups/members-record';
import {
	ABOUT_SPACE_TYPE,
	publicGroup,
	type GroupEventRecord,
	type GroupRow
} from '$lib/groups/types';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);
const META_ONLY = 'atproto space:group.opensocial.meta?authority=*&action=read';

const PADDLE: GroupEventRecord = {
	uri: `at://${GROUP_DID}/community.lexicon.calendar.event/3lpaddle`,
	cid: 'bafypaddle',
	rkey: '3lpaddle',
	value: { name: 'Sunrise paddle' }
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
	vi.mocked(listGroupEvents).mockResolvedValue([PADDLE]);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.restoreAllMocks();
	resetReaderHost();
});

const CALENDAR = groupSpaceUris(GROUP_DID).calendarSpaceUri;
const MEETING = {
	space: CALENDAR,
	collection: 'community.lexicon.calendar.event',
	rkey: '3lmeeting',
	value: {
		name: 'Committee call',
		createdAt: '2026-10-02T09:00:00.000Z',
		media: [
			{
				role: 'thumbnail',
				content: {
					$type: 'blob',
					ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }
				}
			}
		]
	}
};

function host(
	isPublic: boolean,
	{ records = [], fail }: { records?: SpaceRecordInput[]; fail?: SpaceReaderOptions['fail'] } = {}
) {
	const access = groupAccessRecord({
		spaceType: ABOUT_SPACE_TYPE,
		roles: ABOUT_SPACE_READER_ROLES,
		public: isPublic
	});
	serveReader(
		GROUP_DID,
		authzReader(
			GROUP_DID,
			{ [OWNER]: 'admin', [MEMBER]: 'member' },
			{
				fail,
				records: [
					{
						space: ABOUT,
						collection: GROUP_ACCESS_COLLECTION,
						rkey: GROUP_ACCESS_RKEY,
						value: { ...access, $type: GROUP_ACCESS_COLLECTION }
					},
					...records
				]
			}
		)
	);
}

async function openAs(did: string | null, scope?: string) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did, session: did ? readerSession(did, scope) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events`)
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown>;
}

describe('/groups/[actor]/events load', () => {
	it("shows a public group's public events to anyone, with only the row's public fields", async () => {
		host(true);
		for (const did of [null, STRANGER, MEMBER]) {
			const data = await openAs(did);
			expect(data, String(did)).toMatchObject({ groupName: 'Kona', events: [PADDLE] });
			expect(data.group).toStrictEqual(publicGroup(row));
		}
	});

	it('shows a member the members-only events beside the public ones, without their images', async () => {
		host(true, { records: [MEETING] });
		const events = (await openAs(MEMBER)).events as GroupEventRecord[];
		expect(events.map((e) => e.rkey).sort()).toEqual(['3lmeeting', '3lpaddle']);
		const meeting = events.find((e) => e.rkey === '3lmeeting')!;
		expect(meeting.space).toBe(CALENDAR);
		expect(meeting.value).not.toHaveProperty('media');
		for (const did of [null, STRANGER]) {
			expect((await openAs(did)).events, String(did)).toEqual([PADDLE]);
		}
	});

	it("tells a member why they see no members-only events when the calendar space can't be read", async () => {
		host(true, {
			fail: (call) => (call.space === CALENDAR ? new Error('host failed: 502') : undefined)
		});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const data = await openAs(MEMBER);
		expect(data.events).toEqual([PADDLE]);
		expect(data.membersOnlyNotice).toBe("Members-only events couldn't be loaded right now.");
		expect((await openAs(STRANGER)).membersOnlyNotice).toBeNull();
	});

	it('lets only a role that writes the group repo create or manage events', async () => {
		host(true);
		expect(await openAs(OWNER)).toMatchObject({ canCreateEvent: true, canManageEvents: true });
		expect(await openAs(MEMBER)).toMatchObject({ canCreateEvent: false, canManageEvents: false });
	});

	it('shows no events, rather than failing, when the index cannot be read', async () => {
		host(true);
		vi.mocked(listGroupEvents).mockRejectedValue(new Error('index down'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect((await openAs(null)).events).toEqual([]);
	});

	it('gives a member hidden by a private group only the sign-in notice, and anyone else a 404', async () => {
		host(false);
		expect(await openAs(MEMBER, META_ONLY)).toStrictEqual({
			groupDid: GROUP_DID,
			signInOnly: true
		});
		expect(listGroupEvents).not.toHaveBeenCalled();
		await expect(openAs(STRANGER)).rejects.toMatchObject({ status: 404 });
	});
});

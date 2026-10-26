import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { authzReader } from '$lib/groups/server/__fixtures__/members-space';
import {
	fixtureSessions,
	readerSession,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import type { SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
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
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const EVENT = 'community.lexicon.calendar.event';
const { aboutSpaceUri: ABOUT, calendarSpaceUri: CALENDAR } = groupSpaceUris(GROUP_DID);
const MEETING = {
	$type: EVENT,
	name: 'Committee call',
	startsAt: '2026-11-02T18:00:00.000Z',
	media: [
		{
			role: 'thumbnail',
			content: {
				$type: 'blob',
				ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }
			}
		}
	]
};

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	const access = groupAccessRecord({
		spaceType: ABOUT_SPACE_TYPE,
		roles: ABOUT_SPACE_READER_ROLES,
		public: true
	});
	serveReader(
		GROUP_DID,
		authzReader(
			GROUP_DID,
			{ [OWNER]: 'admin', [MEMBER]: 'member' },
			{
				records: [
					{
						space: ABOUT,
						collection: GROUP_ACCESS_COLLECTION,
						rkey: GROUP_ACCESS_RKEY,
						value: { ...access, $type: GROUP_ACCESS_COLLECTION }
					},
					{ space: CALENDAR, collection: EVENT, rkey: '3lmeeting', value: MEETING }
				]
			}
		)
	);
});

afterEach(() => {
	harness.close();
	vi.restoreAllMocks();
	resetReaderHost();
});

async function openAs(did: string | null, rkey: string) {
	return (await load({
		params: { actor: GROUP_DID, rkey },
		locals: { did, session: did ? readerSession(did) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}`)
	} as unknown as Parameters<typeof load>[0])) as Record<string, unknown> & {
		eventData: Record<string, unknown>;
	};
}

describe('/groups/[actor]/events/[rkey] load', () => {
	it('shows a member the event without its image, at its space URI', async () => {
		const data = await openAs(MEMBER, '3lmeeting');
		expect(data.eventData).toMatchObject({ name: 'Committee call', did: GROUP_DID });
		expect(data.eventData).not.toHaveProperty('media');
		expect(data.eventUri).toBe(`${CALENDAR}/${GROUP_DID}/${EVENT}/3lmeeting`);
		expect(data.spaceUri).toBe(CALENDAR);
		expect(data.membersOnly).toBe(true);
		expect(data).not.toHaveProperty('editHref');
	});

	it('links whoever may manage events to the edit page, naming the placement', async () => {
		const data = await openAs(OWNER, '3lmeeting');
		expect(data.editHref).toBe(`/groups/${GROUP_DID}/events/3lmeeting/edit?placement=members`);
	});

	it('answers a stranger, a signed-out visitor and a made-up key with the same 404', async () => {
		for (const [did, rkey] of [
			[STRANGER, '3lmeeting'],
			[STRANGER, '3lmadeup'],
			[null, '3lmeeting'],
			[MEMBER, '3lmadeup']
		] as const) {
			await expect(openAs(did, rkey), `${did} ${rkey}`).rejects.toMatchObject({
				status: 404,
				body: { message: 'Event not found' }
			});
		}
	});
});

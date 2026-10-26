import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/contrail', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail')>()),
	getEventRecordFromContrail: vi.fn()
}));
vi.mock('$lib/contrail/index', () => ({
	getServerClient: () => ({ get: async () => ({ ok: false }) })
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));
vi.mock('@atmo-dev/events-ui', async () => ({
	getProfileUrl: (await import('@atmo-dev/events-ui/profile-url')).getProfileUrl
}));

import { load } from './+page.server';
import { getEventRecordFromContrail } from '$lib/contrail';
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
const PADDLE_URI = `at://${GROUP_DID}/${EVENT}/3lpaddle`;
const PADDLE = { $type: EVENT, name: 'Sunrise paddle', startsAt: '2030-11-01T06:00:00.000Z' };
const CALENDAR = groupSpaceUris(GROUP_DID).calendarSpaceUri;
const IMAGE = {
	role: 'thumbnail',
	content: {
		$type: 'blob',
		ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
		mimeType: 'image/png',
		size: 3
	}
};

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	serveReader(
		GROUP_DID,
		authzReader(
			GROUP_DID,
			{ [OWNER]: 'admin', [MEMBER]: 'member' },
			{
				records: [
					// A members-only event that shares its key with the public one.
					{
						space: CALENDAR,
						collection: EVENT,
						rkey: '3lpaddle',
						value: { ...PADDLE, name: 'Members paddle', media: [IMAGE] }
					},
					{
						space: groupSpaceUris(GROUP_DID).aboutSpaceUri,
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
					}
				]
			}
		)
	);
	vi.mocked(getEventRecordFromContrail).mockResolvedValue({
		uri: PADDLE_URI,
		cid: 'bafypaddle',
		did: GROUP_DID,
		rkey: '3lpaddle',
		value: PADDLE
	} as never);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	resetReaderHost();
});

function openAs(did: string | null, rkey: string, placement?: string) {
	const url = new URL(`https://atmo.test/groups/${GROUP_DID}/events/${rkey}/edit`);
	if (placement) url.searchParams.set('placement', placement);
	return load({
		params: { actor: GROUP_DID, rkey },
		locals: { did, session: did ? readerSession(did) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url
	} as unknown as Parameters<typeof load>[0]);
}

describe('/groups/[actor]/events/[rkey]/edit load', () => {
	it('refuses anyone who may not manage events the same way for any key, before reading the event', async () => {
		for (const did of [MEMBER, STRANGER, null]) {
			for (const rkey of ['3lpaddle', '3lmadeup']) {
				await expect(openAs(did, rkey), `${did} ${rkey}`).rejects.toMatchObject({ status: 403 });
			}
		}
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();
	});

	it('hands the editor the event as the index holds it', async () => {
		expect(await openAs(OWNER, '3lpaddle')).toStrictEqual({
			groupDid: GROUP_DID,
			groupName: 'Kona',
			handle: null,
			canDelete: true,
			rkey: '3lpaddle',
			eventData: {
				...PADDLE,
				cid: 'bafypaddle',
				did: GROUP_DID,
				rkey: '3lpaddle',
				uri: PADDLE_URI
			},
			space: null
		});
	});

	it('reads a members-only event from the calendar space only when the link says so, image kept', async () => {
		const data = (await openAs(OWNER, '3lpaddle', 'members')) as Record<string, unknown> & {
			eventData: Record<string, unknown>;
		};
		expect(data.space).toBe(CALENDAR);
		expect(data.eventData).toMatchObject({
			name: 'Members paddle',
			media: [IMAGE],
			did: GROUP_DID,
			rkey: '3lpaddle',
			uri: `${CALENDAR}/${GROUP_DID}/${EVENT}/3lpaddle`
		});
		expect(data.eventData).not.toHaveProperty('space');
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();
		await expect(openAs(OWNER, '3lmadeup', 'members')).rejects.toMatchObject({ status: 404 });
	});

	it('answers 404 for a placement it does not know, without reading anything', async () => {
		await expect(openAs(OWNER, '3lpaddle', 'public')).rejects.toMatchObject({ status: 404 });
		expect(getEventRecordFromContrail).not.toHaveBeenCalled();
	});

	it('answers 404 for an event the index does not hold or cannot read', async () => {
		vi.mocked(getEventRecordFromContrail).mockResolvedValue(null);
		await expect(openAs(OWNER, '3lmadeup')).rejects.toMatchObject({ status: 404 });
		vi.mocked(getEventRecordFromContrail).mockRejectedValue(new Error('D1 is down'));
		await expect(openAs(OWNER, '3lpaddle')).rejects.toMatchObject({ status: 404 });
	});
});

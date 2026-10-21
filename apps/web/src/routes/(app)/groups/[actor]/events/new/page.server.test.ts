import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The new-event page's loader, behind the real editor gate. The space reader is
// a fake host whose members space holds the records a create leaves, which a
// roster caller's standing comes from, read with their own access: the owner's
// role grants CREATE_EVENT and a plain member's grants nothing. Its about space's access record makes the group
// public, so a caller off the roster reaches the editor gate too.
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
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;

beforeEach(async () => {
	({ harness } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
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
					{
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
					}
				]
			}
		)
	);
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	resetReaderHost();
});

/** The page as `did` sees it, signed in with their own session, or signed out. */
async function openAs(did: string | null) {
	return load({
		params: { actor: GROUP_DID },
		locals: { did, session: did ? readerSession(did) : null },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } },
		url: new URL(`https://atmo.test/groups/${GROUP_DID}/events/new`)
	} as unknown as Parameters<typeof load>[0]);
}

describe('/groups/[actor]/events/new load: who may open it', () => {
	// The page is the first gate on publishing as the group, so a caller who may
	// see a public group but not create its events, on the roster or off it, is
	// refused here rather than handed the editor.
	it('the new-event page refuses a caller without CREATE_EVENT and serves one with it', async () => {
		for (const did of [MEMBER, STRANGER]) {
			await expect(openAs(did), did).rejects.toMatchObject({
				status: 403,
				body: { message: 'Not allowed: CREATE_EVENT required' }
			});
		}

		expect(await openAs(OWNER)).toMatchObject({ groupDid: GROUP_DID, groupName: 'Kona' });
	});
});

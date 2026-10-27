import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/groups/server/browse', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/browse')>()),
	listDeclaredGroups: vi.fn(async () => [])
}));
vi.mock('$lib/groups/server/identities', () => ({
	knownHandles: vi.fn(async () => new Map())
}));
vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('$lib/groups/server/__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import {
	breakSession,
	fixtureSessions,
	resetReaderHost,
	serveReader
} from '$lib/groups/server/__fixtures__/reader-host';
import { listDeclaredGroups } from '$lib/groups/server/browse';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { seedGroup } from '$lib/groups/server/__fixtures__/seed-group';
import { hostDown, spaceReader } from '$lib/groups/server/__fixtures__/space-reader';

const ALICE = 'did:plc:alice';

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
	resetReaderHost();
});

async function browse() {
	return (await load({
		locals: { did: ALICE },
		platform: { env: { DB: harness.db, OAUTH_SESSIONS: fixtureSessions } }
	} as unknown as Parameters<typeof load>[0])) as {
		groups: { group_did: string; name: string | null; hosted: boolean; listed: boolean }[];
	};
}

describe('/groups load', () => {
	it("lists the declared groups and the caller's own from the rows, reading no space", async () => {
		await seedGroup({ harness, groupDid: 'did:plc:listed', creatorDid: ALICE, name: 'Listed' });
		await seedGroup({ harness, groupDid: 'did:plc:unlisted', creatorDid: ALICE, name: 'Unlisted' });
		const down = spaceReader('did:plc:unlisted', { fail: hostDown(502) });
		serveReader('did:plc:unlisted', down);
		breakSession('did:plc:listed');
		vi.mocked(listDeclaredGroups).mockResolvedValueOnce([
			{ did: 'did:plc:listed', indexedAt: Date.now() },
			{ did: 'did:plc:elsewhere', indexedAt: Date.now() }
		]);

		const byDid = Object.fromEntries((await browse()).groups.map((g) => [g.group_did, g]));

		expect(byDid).toMatchObject({
			'did:plc:listed': { name: 'Listed', hosted: true, listed: true },
			'did:plc:unlisted': { name: 'Unlisted', hosted: true, listed: false },
			'did:plc:elsewhere': { name: null, hosted: false, listed: true }
		});
		expect(down.calls).toEqual([]);
		expect(fixtureSessions.reads).toBe(0);
	});
});

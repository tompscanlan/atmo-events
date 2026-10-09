// A group's handle is shown only when its PDS says the handle and the DID point
// at each other. A handle that fails that check may belong to someone else now,
// so showing it, or caching it for every later page, would hand the group's
// name to whoever registered it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/methods', () => ({ getPDS: vi.fn() }));

import { getPDS } from '$lib/atproto/methods';
import { refreshGroupHandle } from './handles';
import { knownHandles } from './identities';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const PDS = 'https://pds.stub.test';
const HANDLE = 'kona.groups.example.com';

let harness: SqliteD1;
let describeRepo: () => Response;

beforeEach(() => {
	harness = sqliteD1();
	// Contrail's cache, which a D1 made from migrations/ alone does not have.
	harness.raw.exec(
		'CREATE TABLE identities (did TEXT PRIMARY KEY, handle TEXT, pds TEXT, resolved_at INTEGER)'
	);
	vi.mocked(getPDS).mockResolvedValue(PDS);
	describeRepo = () => Response.json({ did: GROUP_DID, handle: HANDLE, handleIsCorrect: true });
	vi.stubGlobal('fetch', async (input: URL | string | Request) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		if (url.origin === PDS && url.pathname === '/xrpc/com.atproto.repo.describeRepo') {
			return describeRepo();
		}
		return Response.json({ error: 'NotExpected' }, { status: 500 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	harness.close();
});

const cached = async () => (await knownHandles(harness.db, [GROUP_DID])).get(GROUP_DID) ?? null;

describe('refreshGroupHandle', () => {
	it('shows and caches a handle the PDS verified both ways', async () => {
		expect(await refreshGroupHandle(harness.db, GROUP_DID)).toBe(HANDLE);
		expect(await cached()).toBe(HANDLE);
	});

	it('neither shows nor caches a handle that failed the two-way check', async () => {
		describeRepo = () =>
			Response.json({ did: GROUP_DID, handle: 'taken.example.com', handleIsCorrect: false });
		expect(await refreshGroupHandle(harness.db, GROUP_DID)).toBeNull();
		expect(await cached()).toBeNull();
	});

	it('keeps the handle it had when a later check fails', async () => {
		await refreshGroupHandle(harness.db, GROUP_DID);
		describeRepo = () =>
			Response.json({ did: GROUP_DID, handle: 'taken.example.com', handleIsCorrect: false });

		expect(await refreshGroupHandle(harness.db, GROUP_DID)).toBeNull();
		expect(await cached()).toBe(HANDLE);
	});

	it('shows the DID when the DID does not resolve', async () => {
		vi.mocked(getPDS).mockRejectedValue(new Error('no doc'));
		expect(await refreshGroupHandle(harness.db, GROUP_DID)).toBeNull();
		expect(await cached()).toBeNull();
	});
});

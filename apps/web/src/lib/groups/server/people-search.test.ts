import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real module pulls in the UI package. The stub keeps the one rule that
// matters here: a profile with an avatar gets a URL, one without gets none.
vi.mock('$lib/contrail', () => ({
	getProfileBlobUrl: (did: string, blob: unknown) => (blob ? `https://cdn.test/${did}` : undefined)
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { searchPeopleByHandle } from './people-search';

// The two tables are Contrail's; the groups schema does not create them, so each
// case builds the ones it needs, as the index would have.
const IDENTITIES = `CREATE TABLE identities (did TEXT PRIMARY KEY, handle TEXT, pds TEXT,
	resolved_at INTEGER NOT NULL)`;
const PROFILES = `CREATE TABLE records_profile (uri TEXT PRIMARY KEY, did TEXT NOT NULL,
	rkey TEXT NOT NULL, cid TEXT, record TEXT, time_us INTEGER NOT NULL, indexed_at INTEGER NOT NULL)`;

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

afterEach(() => {
	harness.close();
});

function identity(did: string, handle: string) {
	harness.raw.prepare(`INSERT INTO identities VALUES (?, ?, NULL, 0)`).run(did, handle);
}

function profile(did: string, value: object) {
	harness.raw
		.prepare(`INSERT INTO records_profile VALUES (?, ?, 'self', NULL, ?, 0, 0)`)
		.run(`at://${did}/app.bsky.actor.profile/self`, did, JSON.stringify(value));
}

describe('searchPeopleByHandle', () => {
	it('matches handles by prefix, in handle order, with the indexed profile', async () => {
		harness.raw.exec(IDENTITIES);
		harness.raw.exec(PROFILES);
		identity('did:plc:bob', 'bob.test');
		identity('did:plc:alice', 'alice.test');
		identity('did:plc:alex', 'alex.test');
		profile('did:plc:alice', { displayName: 'Alice', avatar: { ref: 'blob' } });

		const found = await searchPeopleByHandle(harness.db, '@Al');

		expect(found).toEqual([
			{ did: 'did:plc:alex', handle: 'alex.test', displayName: null, avatar: null },
			{
				did: 'did:plc:alice',
				handle: 'alice.test',
				displayName: 'Alice',
				avatar: 'https://cdn.test/did:plc:alice'
			}
		]);
	});

	it('never suggests an account whose handle did not verify', async () => {
		harness.raw.exec(IDENTITIES);
		identity('did:plc:gone', 'handle.invalid');
		expect(await searchPeopleByHandle(harness.db, 'handle')).toEqual([]);
	});

	it('asks nothing for a prefix too short or not a handle', async () => {
		harness.raw.exec(IDENTITIES);
		identity('did:plc:alice', 'alice.test');
		expect(await searchPeopleByHandle(harness.db, 'a')).toEqual([]);
		expect(await searchPeopleByHandle(harness.db, "al' OR 1=1")).toEqual([]);
	});

	it('still matches handles on a D1 with no profile table', async () => {
		harness.raw.exec(IDENTITIES);
		identity('did:plc:alice', 'alice.test');
		expect(await searchPeopleByHandle(harness.db, 'ali')).toEqual([
			{ did: 'did:plc:alice', handle: 'alice.test', displayName: null, avatar: null }
		]);
	});

	it('matches nothing on a D1 with no identities table', async () => {
		expect(await searchPeopleByHandle(harness.db, 'ali')).toEqual([]);
	});
});

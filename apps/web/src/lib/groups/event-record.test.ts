// THE ADDRESS RULE, found on the live fixture by scripts/groups-e2e.mjs.
//
// This path used to send `country: ''` for a typed location. The address
// lexicon requires country 2..10, so `writeGroupEvent`'s validator refused the
// whole record — every group event carrying a location name failed, with the
// unhelpful "that is not a valid community.lexicon.calendar.event record".
//
// These cases go through the real gate rather than inspecting the builder's
// return value, because "is the record writable" is the contract: a record that
// fails validation never reaches a PDS, location or no location.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './server/__fixtures__/d1-sqlite';
import { createGroup } from './server/repo';
import { writeGroupEvent, type GroupRepoWrite, type GroupRepoWriter } from './server/event-writer';
import { ADDRESS_TYPE, groupEventRecord } from './event-record';
import type { GroupRow } from './types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;

// The writer takes an env only for GROUP_CREDENTIAL_KEY, and these cases
// inject their own writer, so it is never consulted.
const env = {};

/** The form's fields for a location typed in Kona, with whatever country. */
function submit(locationCountry?: string) {
	return groupEventRecord({
		name: 'Kona sunrise paddle',
		startsAt: '2026-10-04T17:00:00.000Z',
		endsAt: '2026-10-04T19:00:00.000Z',
		createdAt: '2026-09-01T12:00:00.000Z',
		locationName: 'Kona',
		locationCountry
	});
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	writes = [];
	writer = async (write) => {
		writes.push(write);
		return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: 'bafytest' };
	};
});

afterEach(() => harness.close());

async function write(record: Record<string, unknown>) {
	return writeGroupEvent({
		db,
		env,
		group,
		callerDid: OWNER,
		intent: 'create',
		record,
		writer,
		// These cases are about record SHAPE; the index is the write gate's own
		// test's subject, and the real notifier would stand up an appview.
		notify: async () => {}
	});
}

describe('group event locations', () => {
	it('writes a location with a country as one address entry', async () => {
		await write(submit('US'));
		expect(writes[0].record.locations).toEqual([
			{ $type: ADDRESS_TYPE, name: 'Kona', country: 'US' }
		]);
	});

	// The regression guard: this threw GroupRecordError before the fix.
	it('writes an event whose location has no country, without an address entry', async () => {
		const result = await write(submit(undefined));

		expect(result.repo).toBe(GROUP_DID);
		expect(writes[0].record.locations).toBeUndefined();
		expect(writes[0].record.name).toBe('Kona sunrise paddle');
	});

	it('treats a blank country as no country, not as an empty address', async () => {
		await write(submit('   '));
		expect(writes[0].record.locations).toBeUndefined();
	});
});

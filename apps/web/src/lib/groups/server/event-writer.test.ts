// The write gate. What these cases are really defending is one
// mistake: copying `repo: locals.did` out of $lib/atproto/server/repo.remote.ts
// into the group path. That would look fine, pass every permission check, and
// silently author group events under whichever admin happened to click — which
// is precisely the model this whole feature exists to avoid.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, setMemberStatus } from './repo';
import {
	GROUP_EVENT_COLLECTION,
	GroupCredentialError,
	GroupPermissionError,
	GroupRecordError,
	deleteGroupEvent,
	writeGroupEvent,
	type GroupRepoWrite,
	type GroupRepoWriter
} from './event-writer';
import type { GroupRow } from '../types';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
/** The admin in every case below: a non-owner who was promoted, exactly the
 *  actor the co-editing requirement is about. */
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;

// The writer takes an env only for GROUP_CREDENTIAL_KEY, and these cases
// inject their own writer, so it is never consulted.
const env = {};

function validRecord(name = 'Kona weekly ride') {
	return {
		name,
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	};
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: 'bafytest' };
	};
});

afterEach(() => harness.close());

describe('authorship', () => {
	// The headline requirement: a NON-OWNER admin edits an event they did not
	// create, and the record that lands is the GROUP's.
	it('lets a non-owner admin edit an event the owner created, as the group', async () => {
		const created = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: OWNER,
			intent: 'create',
			record: validRecord(),
			writer
		});
		expect(created.repo).toBe(GROUP_DID);

		const edited = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			intent: 'update',
			rkey: created.rkey,
			record: {
				...validRecord('Kona weekly ride — new time'),
				startsAt: '2026-09-21T18:00:00.000Z'
			},
			writer
		});

		expect(edited.rkey).toBe(created.rkey);
		expect(edited.repo).toBe(GROUP_DID);
		expect(edited.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);

		// Not the admin's repo, not the owner's, not `locals.did` — the group's.
		expect(writes.map((w) => w.repo)).toEqual([GROUP_DID, GROUP_DID]);
		expect(writes.some((w) => w.repo === ADMIN || w.repo === OWNER)).toBe(false);
		expect(writes[1].intent).toBe('update');
		expect(writes[1].record.name).toBe('Kona weekly ride — new time');
	});

	it('mints a TID for a create and reuses the given rkey for an update', async () => {
		const created = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			intent: 'create',
			record: validRecord(),
			writer
		});
		expect(created.rkey).toMatch(/^[a-z2-7]{13}$/);
		expect(writes[0].intent).toBe('create');

		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'update',
				record: validRecord(),
				writer
			})
		).rejects.toBeInstanceOf(GroupRecordError);
	});

	// If the transport reports a URI under some other authority, the model has
	// been violated and the caller must not be told the write succeeded.
	it('refuses a result whose URI is not in the group repo', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'create',
				record: validRecord(),
				writer: async () => ({ uri: `at://${ADMIN}/${GROUP_EVENT_COLLECTION}/abc`, cid: 'x' })
			})
		).rejects.toThrow(/is not did:plc:jcwgw6fcnb5vyoid7nz7sl26's repo/);
	});
});

describe('the permission gate', () => {
	it('refuses a plain member: no CREATE_EVENT, no MANAGE_EVENTS', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				intent: 'create',
				record: validRecord(),
				writer
			})
		).rejects.toMatchObject({ permission: 'CREATE_EVENT' });
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				intent: 'update',
				rkey: '3abc',
				record: validRecord(),
				writer
			})
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });
		expect(writes).toEqual([]);
	});

	it('refuses an off-roster DID and an anonymous caller', async () => {
		for (const callerDid of [STRANGER, null]) {
			await expect(
				writeGroupEvent({
					db,
					env,
					group,
					callerDid,
					intent: 'create',
					record: validRecord(),
					writer
				})
			).rejects.toBeInstanceOf(GroupPermissionError);
		}
		expect(writes).toEqual([]);
	});

	// Suspension has to bite here, not just on the members page.
	it('refuses a suspended admin', async () => {
		await setMemberStatus(db, group.id, ADMIN, 'suspended');
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'create',
				record: validRecord(),
				writer
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
		expect(writes).toEqual([]);
	});

	it('gates deletion on MANAGE_EVENTS and deletes from the group repo', async () => {
		await expect(
			deleteGroupEvent({ db, env, group, callerDid: MEMBER, rkey: '3abc', writer })
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });

		const deleted = await deleteGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			rkey: '3abc',
			writer
		});
		expect(deleted.repo).toBe(GROUP_DID);
		expect(writes).toEqual([
			{
				repo: GROUP_DID,
				collection: GROUP_EVENT_COLLECTION,
				rkey: '3abc',
				record: {},
				intent: 'delete'
			}
		]);
	});
});

describe('record validation', () => {
	it('rejects a malformed record before anything reaches the transport', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'create',
				// No `name`, which the lexicon requires.
				record: { createdAt: '2026-09-01T12:00:00.000Z' },
				writer
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(writes).toEqual([]);
	});

	it('stamps the collection $type rather than trusting the caller', async () => {
		await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			intent: 'create',
			record: { ...validRecord(), $type: 'app.bsky.feed.post' },
			writer
		});
		expect(writes[0].record.$type).toBe(GROUP_EVENT_COLLECTION);
		expect(writes[0].collection).toBe(GROUP_EVENT_COLLECTION);
	});
});

describe('credentials', () => {
	// A group whose DID the app holds no credential for cannot publish. That is
	// an operator problem and must be reported as one, not as a 500 from the PDS.
	it('fails with a credential error when no credential is configured', async () => {
		await expect(
			writeGroupEvent({ db, env, group, callerDid: ADMIN, intent: 'create', record: validRecord() })
		).rejects.toBeInstanceOf(GroupCredentialError);
	});

	it('checks the permission before the credential', async () => {
		// Order matters: a member must be told they lack the permission, not that
		// the deployment is misconfigured.
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				intent: 'create',
				record: validRecord()
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
	});
});

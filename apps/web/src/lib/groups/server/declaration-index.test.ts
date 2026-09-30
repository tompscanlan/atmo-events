// Our own declaration index, run in process over one SQLite database, and what
// a declaration write or withdrawal does to it.
//
// One database for the whole file, not one per case: `ensureInit` creates the
// index's tables once per module, on the first database it sees, so a second
// database would have no tables at all. Each case uses its own group DID
// instead.
//
// The PDS is a stub behind `fetch`. The index resolves a DID to its PDS through
// the `identities` row the mint writes, and then asks that PDS for the record,
// so the stub answers `com.atproto.repo.getRecord` and refuses anything else.
// What matters is the index's rule: a record the PDS does not return is
// deleted, whatever the reason the PDS gave.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensureInit, getServerClient } from '$lib/contrail/index';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import {
	GROUP_DECLARATION_COLLECTION,
	GROUP_DECLARATION_RKEY,
	groupDeclarationRecord
} from '../declaration-record';
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { listDeclaredGroups } from './declaration-index';
import { reconcileGroupDeclaration, removeGroupDeclaration } from './declaration-writer';
import { registerGroupIdentity } from './events-index';
import type { GroupRepoWriter } from './event-writer';
import { createGroup } from './repo';
import { spaceUri } from './spaces';

const OWNER = 'did:plc:owner';
const PDS = 'https://pds.example.test';

/** What the stub PDS holds, by at-uri. `down` makes it answer 502 to every
 *  read, the transient failure a notify must never be exposed to. */
const pds = new Map<string, Record<string, unknown>>();
let down = false;
let getRecordCalls: string[] = [];

let harness: SqliteD1;
let db: D1Database;

// The writer takes an env only for GROUP_CREDENTIAL_KEY, and these cases inject
// their own writer, so it is never consulted.
const env = {};

function declarationUri(groupDid: string): string {
	return `at://${groupDid}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;
}

function stubPds(input: RequestInfo | URL): Response {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin !== PDS || url.pathname !== '/xrpc/com.atproto.repo.getRecord') {
		throw new Error(`unexpected fetch in this test: ${url}`);
	}
	const uri = `at://${url.searchParams.get('repo')}/${url.searchParams.get('collection')}/${url.searchParams.get('rkey')}`;
	getRecordCalls.push(uri);
	if (down) return Response.json({ error: 'InternalServerError' }, { status: 502 });
	const value = pds.get(uri);
	if (!value) {
		return Response.json(
			{ error: 'RecordNotFound', message: `Could not locate record: ${uri}` },
			{ status: 400 }
		);
	}
	return Response.json({
		uri,
		cid: 'bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a',
		value
	});
}

/** A writer that applies the write to the stub PDS, as the real one applies it
 *  to the group's repo. */
const writer: GroupRepoWriter = async (write) => {
	const uri = `at://${write.repo}/${write.collection}/${write.rkey}`;
	if (write.intent === 'delete') pds.delete(uri);
	else pds.set(uri, write.record);
	return { uri, cid: 'bafytest' };
};

/** A public group we host, its identity registered the way the mint does it,
 *  and its declaration both on the PDS and in our index. */
async function declaredGroup(groupDid: string, createdAt?: string): Promise<GroupRow> {
	const created = await createGroup(db, { groupDid, ownerDid: OWNER, name: 'Kona' });
	expect(
		await registerGroupIdentity(db, { did: groupDid, handle: 'kona.pds.example.test', pds: PDS })
	).toBe(true);
	const uri = declarationUri(groupDid);
	pds.set(uri, {
		...groupDeclarationRecord({
			aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self'),
			createdAt
		}),
		$type: GROUP_DECLARATION_COLLECTION
	});
	await notify(uri);
	expect(await declaredDids()).toContain(groupDid);
	getRecordCalls = [];
	return { ...created, about_space_uri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self') };
}

async function notify(uri: string) {
	const res = await getServerClient(db).post('rsvp.atmo.notifyOfUpdate', {
		input: { uris: [uri as ResourceUri] }
	});
	if (!res.ok) throw new Error(`notifyOfUpdate failed: ${JSON.stringify(res.data)}`);
	return res.data;
}

async function declaredDids(): Promise<string[]> {
	return (await listDeclaredGroups(db)).map((d) => d.did);
}

beforeAll(async () => {
	harness = sqliteD1();
	db = harness.db;
	// The index's own tables, `identities` among them, which the mint writes to
	// before anything has queried the index.
	await ensureInit(db);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => stubPds(input))
	);
});

afterEach(() => {
	down = false;
});

afterAll(() => {
	vi.unstubAllGlobals();
	harness.close();
});

describe('our declaration index', () => {
	// The standard's declaration has only `meta`. Ours also carries `createdAt`,
	// because browse lists the newest group first, and this is where it is read.
	it('lists declarations newest first, with the date each one carries', async () => {
		const older = await declaredGroup(
			'did:plc:vq2mtsxokd6ajwn4c5ldaxfz',
			'2026-01-02T03:04:05.000Z'
		);
		const newer = await declaredGroup(
			'did:plc:ohb3quxgnfq7lxdkamqesfyc',
			'2026-06-07T08:09:10.000Z'
		);

		const listed = (await listDeclaredGroups(db)).filter((d) =>
			[older.group_did, newer.group_did].includes(d.did)
		);

		expect(listed).toEqual([
			{ did: newer.group_did, createdAt: '2026-06-07T08:09:10.000Z' },
			{ did: older.group_did, createdAt: '2026-01-02T03:04:05.000Z' }
		]);
	});

	// The premise the withdrawal relies on: the index re-reads the URI from the
	// group's PDS, finds nothing, and deletes its entry.
	it('notifyOfUpdate deletes an indexed declaration the PDS no longer has', async () => {
		const group = await declaredGroup('did:plc:kfrvrhyjbfbk2fljyomwtdc5');
		const uri = declarationUri(group.group_did);
		pds.delete(uri);

		const result = await notify(uri);

		expect(result).toMatchObject({ indexed: 0, deleted: 1 });
		expect(await declaredDids()).not.toContain(group.group_did);
	});

	it('withdrawing a declaration updates our index before any cron tick', async () => {
		const group = await declaredGroup('did:plc:3rj2dwcebnvzfvtg6ximnvsh');

		await removeGroupDeclaration({ db, env, group, callerDid: OWNER, writer });

		expect(await declaredDids()).not.toContain(group.group_did);
		// Once, for this declaration: the index heard it from us, not from a tick.
		expect(getRecordCalls).toEqual([declarationUri(group.group_did)]);
	});

	// The index deletes on ANY answer that is not a record, a 5xx included. A
	// notify after a declare would therefore drop a live declaration whenever
	// the PDS blinked, and nothing would put it back until its next write. The
	// PDS is down for this whole case to show the declare never asks.
	it('a declare never notifies the index', async () => {
		const group = await declaredGroup('did:plc:w5mbhkqzwkb2xdpxa6p5kfnb');
		down = true;

		await reconcileGroupDeclaration({
			db,
			env,
			group,
			visibility: 'public',
			callerDid: OWNER,
			writer
		});

		expect(getRecordCalls).toEqual([]);
		expect(await declaredDids()).toContain(group.group_did);
	});
});

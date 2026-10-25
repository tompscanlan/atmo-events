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
import { listDeclaredGroups } from './browse';
import {
	DeclarationIndexError,
	reconcileGroupDeclaration,
	removeGroupDeclaration
} from './declaration-writer';

import { spaceUri } from '../ids';
import { type GroupRepoWriter } from './group-write';

import { registerGroupIdentity } from './identities';
import { createGroup } from './db/groups';
const OWNER = 'did:plc:owner';
const PDS = 'https://pds.example.test';

const pds = new Map<string, Record<string, unknown>>();
let down = false;
let getRecordCalls: string[] = [];

let harness: SqliteD1;
let db: D1Database;

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

const writer: GroupRepoWriter = async (write) => {
	const uri = `at://${write.repo}/${write.collection}/${write.rkey}`;
	if (write.intent === 'delete') pds.delete(uri);
	else pds.set(uri, write.record);
	return { uri, cid: 'bafytest' };
};

async function declaredGroup(groupDid: string): Promise<GroupRow> {
	const created = await createGroup(db, { groupDid, creatorDid: OWNER, name: 'Kona' });
	expect(
		await registerGroupIdentity(db, { did: groupDid, handle: 'kona.pds.example.test', pds: PDS })
	).toBe(true);
	const uri = declarationUri(groupDid);
	pds.set(uri, {
		...groupDeclarationRecord({ aboutSpaceUri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self') }),
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
	it('lists declarations newest first, by when the index took each one', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		try {
			vi.setSystemTime(1_000_000);
			const older = await declaredGroup('did:plc:vq2mtsxokd6ajwn4c5ldaxfz');
			vi.setSystemTime(2_000_000);
			const newer = await declaredGroup('did:plc:ohb3quxgnfq7lxdkamqesfyc');

			const listed = (await listDeclaredGroups(db)).filter((d) =>
				[older.group_did, newer.group_did].includes(d.did)
			);
			expect(listed.map((d) => d.did)).toEqual([newer.group_did, older.group_did]);
			expect(listed[0].indexedAt).toBeGreaterThan(listed[1].indexedAt);
		} finally {
			vi.useRealTimers();
		}
	});

	it('withdrawing a declaration updates our index before any cron tick', async () => {
		const group = await declaredGroup('did:plc:3rj2dwcebnvzfvtg6ximnvsh');

		await removeGroupDeclaration({ db, env, group, callerDid: group.group_did, writer });

		expect(await declaredDids()).not.toContain(group.group_did);
		expect(getRecordCalls).toEqual([declarationUri(group.group_did)]);
	});

	it('fails a withdrawal the index answered with errors', async () => {
		const groupDid = 'did:plc:unregistered4sm2kqhxpzt6';
		const created = await createGroup(db, { groupDid, creatorDid: OWNER, name: 'Kona' });
		const group = { ...created, about_space_uri: spaceUri(groupDid, ABOUT_SPACE_TYPE, 'self') };

		const error = await removeGroupDeclaration({
			db,
			env,
			group,
			callerDid: group.group_did,
			writer
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DeclarationIndexError);
		expect((error as DeclarationIndexError).groupDid).toBe(groupDid);
	});

	it('a declare never notifies the index', async () => {
		const group = await declaredGroup('did:plc:w5mbhkqzwkb2xdpxa6p5kfnb');
		down = true;

		await reconcileGroupDeclaration({
			db,
			env,
			group,
			visibility: 'public',
			listed: true,
			callerDid: group.group_did,
			writer
		});

		expect(getRecordCalls).toEqual([]);
		expect(await declaredDids()).toContain(group.group_did);
	});
});

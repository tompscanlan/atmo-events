import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const index = vi.hoisted(() => ({
	told: [] as string[],
	down: null as Error | null,
	holds: new Set<string>(),
	asked: 0
}));

vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			if (index.down) throw index.down;
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		},
		async get(nsid: string, { params }: { params: { uri: string } }) {
			if (nsid !== 'rsvp.atmo.declaration.getRecord') throw new Error(`unexpected: ${nsid}`);
			index.asked += 1;
			return { ok: index.holds.has(params.uri), data: {} };
		}
	})
}));

import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import { authzReader } from './__fixtures__/members-space';
import { recordingWriter, type RecordingWriter } from './__fixtures__/space-reader';
import {
	DeclarationIndexError,
	publiclyDeclared,
	reconcileGroupDeclaration,
	removeGroupDeclaration,
	writeGroupDeclaration
} from './declaration-writer';
import { GroupPermissionError } from './group-write';
import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { spaceUri } from '../ids';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const URI = `at://${GROUP_DID}/${GROUP_DECLARATION_COLLECTION}/self`;

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writer: RecordingWriter;
let as: Parameters<typeof writeGroupDeclaration>[0];

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		creatorDid: OWNER,
		name: 'Kona'
	}));
	writer = recordingWriter();
	as = {
		db,
		env: {},
		group,
		callerDid: OWNER,
		writer,
		reader: authzReader(GROUP_DID, { [OWNER]: 'admin' })
	};
	index.told = [];
	index.down = null;
	index.holds = new Set();
	index.asked = 0;
});

afterEach(() => {
	harness.close();
	vi.unstubAllGlobals();
});

describe('writeGroupDeclaration', () => {
	it('puts the meta pointer, and nothing else, in the public repo', async () => {
		const result = await writeGroupDeclaration(as);

		expect(writer.writes).toEqual([
			expect.objectContaining({
				repo: GROUP_DID,
				collection: GROUP_DECLARATION_COLLECTION,
				rkey: 'self',
				intent: 'update',
				record: {
					$type: GROUP_DECLARATION_COLLECTION,
					meta: spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self')
				}
			})
		]);
		expect(writer.writes[0].space).toBeUndefined();
		expect(result.uri).toBe(URI);
		expect(index.told).toEqual([]);
	});
});

describe('reconcileGroupDeclaration', () => {
	it.each([
		['public', true, undefined, ['update']],
		['public', true, true, []],
		['public', false, undefined, ['delete']],
		['private', true, undefined, ['delete']],
		['private', true, false, []]
	] as const)(
		'a %s group, listed %s, declared %s, writes %j',
		async (visibility, listed, declared, intents) => {
			await reconcileGroupDeclaration({ ...as, visibility, listed, declared });
			expect(writer.writes.map((w) => w.intent)).toEqual(intents);
		}
	);
});

describe('a withdrawal and our index', () => {
	it('tells the index only once the delete has landed', async () => {
		const toldBefore: number[] = [];
		await removeGroupDeclaration({
			...as,
			writer: async (write) => {
				toldBefore.push(index.told.length);
				return writer(write);
			}
		});
		expect(toldBefore).toEqual([0]);
		expect(index.told).toEqual([URI]);
	});

	it('does not tell the index when the delete fails', async () => {
		const failing = async () => {
			throw new Error('com.atproto.repo.deleteRecord failed: 502');
		};
		await expect(removeGroupDeclaration({ ...as, writer: failing })).rejects.toThrow();
		expect(index.told).toEqual([]);
	});

	it('fails with DeclarationIndexError after the delete landed, and a retry tells it', async () => {
		index.down = new Error('D1_ERROR: Network connection lost');
		await expect(removeGroupDeclaration(as)).rejects.toBeInstanceOf(DeclarationIndexError);
		expect(writer.writes).toHaveLength(1);

		index.down = null;
		await removeGroupDeclaration(as);
		expect(index.told).toEqual([URI]);
	});

	it.each([
		['a declaration', () => writeGroupDeclaration({ ...as, callerDid: null })],
		['a withdrawal', () => removeGroupDeclaration({ ...as, callerDid: null })]
	])('refuses %s from an anonymous caller before any write', async (_case, run) => {
		await expect(run()).rejects.toBeInstanceOf(GroupPermissionError);
		expect(writer.writes).toEqual([]);
	});
});

describe('publiclyDeclared', () => {
	const repoHost = async () => 'https://pds.stub.test';
	let repoReads: number;

	function repoHolds(holds: boolean) {
		repoReads = 0;
		vi.stubGlobal('fetch', async () => {
			repoReads += 1;
			return holds
				? Response.json({ uri: URI, cid: 'bafy', value: {} })
				: Response.json({ error: 'RecordNotFound' }, { status: 400 });
		});
	}

	it('takes the index’s answer without asking the repo', async () => {
		index.holds.add(URI);
		repoHolds(false);
		expect(await publiclyDeclared(db, GROUP_DID, { repoHost })).toBe(true);
		expect(repoReads).toBe(0);
	});

	it.each([true, false])(
		'asks the repo when the index has none (repo holds it: %s)',
		async (holds) => {
			repoHolds(holds);
			expect(await publiclyDeclared(db, GROUP_DID, { repoHost })).toBe(holds);
			expect(index.asked).toBe(1);
			expect(repoReads).toBe(1);
		}
	);
});

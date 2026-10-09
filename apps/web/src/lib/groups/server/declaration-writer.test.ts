// The declaration writer. Four things here are worth a test:
//   * the record goes to the public repo, not a space. It is the only group
//     record that must be anonymously readable, so a stray `space` would make
//     the group undiscoverable while every "the record was written" assertion
//     still passed;
//   * a private group's declaration is deleted, not just left alone. Absence is
//     the signal, so a stale one keeps announcing a group that asked not to be;
//   * a withdrawal tells our own index, after the PDS delete and never instead
//     of it, and a failure to tell it fails the withdrawal, since browse would
//     still list the group. The index's side of this runs for real in
//     ./browse-index.test.ts;
//   * the gate is MANAGE_GROUP, since announcing a group changes its face.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/** Every URI the index was told about, in order. `down` makes it throw instead. */
const index = vi.hoisted(() => ({ told: [] as string[], down: null as Error | null }));

// The index runs in process over D1, and a real one would need its own database
// and an appview. So its client is replaced, and only that: the notifier that
// calls it is the app's own, failure handling included.
vi.mock('$lib/contrail/index', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/contrail/index')>()),
	getServerClient: () => ({
		async post(nsid: string, { input }: { input: { uris: string[] } }) {
			if (nsid !== 'rsvp.atmo.notifyOfUpdate') throw new Error(`unexpected index call: ${nsid}`);
			if (index.down) throw index.down;
			index.told.push(...input.uris);
			return { ok: true, data: {} };
		}
	})
}));
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';

import {
	DeclarationIndexError,
	reconcileGroupDeclaration,
	removeGroupDeclaration,
	writeGroupDeclaration
} from './declaration-writer';

import { ABOUT_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_DECLARATION_COLLECTION, GROUP_DECLARATION_RKEY } from '../declaration-record';

import { spaceUri } from '../ids';
import { GroupPermissionError, type GroupRepoWrite } from './group-write';
import { authzReader } from './__fixtures__/members-space';
import {
	recordingWriter,
	type FakeSpaceReader,
	type RecordingWriter
} from './__fixtures__/space-reader';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: RecordingWriter;
let authz: FakeSpaceReader;

// The writer takes an env only to find the group's linked session, and these
// cases inject their own writer, so it is never consulted.
const env = {};

beforeEach(async () => {
	({ harness, db, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
	// The gate resolves callers from the members space's records, in memory.
	authz = authzReader(GROUP_DID, { [OWNER]: 'owner', [MEMBER]: 'member' });

	writer = recordingWriter();
	writes = writer.writes;
});

afterEach(() => harness.close());

describe('writeGroupDeclaration', () => {
	it('writes to the public repo, not a space, so an anonymous reader can fetch it', async () => {
		const result = await writeGroupDeclaration({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader: authz
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			repo: GROUP_DID,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: 'self',
			// A singleton: re-declaring must overwrite, not fail on a record
			// that is already there.
			intent: 'update'
		});
		expect(writes[0].space).toBeUndefined();
		expect(result.uri).toBe(`at://${GROUP_DID}/${GROUP_DECLARATION_COLLECTION}/self`);
	});

	it('carries the meta space pointer and nothing that names the group', async () => {
		await writeGroupDeclaration({ db, env, group, callerDid: OWNER, writer, reader: authz });

		const record = writes[0].record as Record<string, unknown>;
		expect(record.meta).toBe(ABOUT);
		expect(typeof record.createdAt).toBe('string');
		// "Discovery only": a peer finds the group and asks the meta space for
		// the rest. Anything renderable here would be a promise the space
		// refuses to keep for an anonymous caller.
		expect(Object.keys(record).sort()).toEqual(['$type', 'createdAt', 'meta']);
	});
});

describe('reconcileGroupDeclaration', () => {
	it('DELETES the declaration when a group turns private', async () => {
		await reconcileGroupDeclaration({
			db,
			env,
			group,
			visibility: 'private',
			callerDid: OWNER,
			writer,
			reader: authz
		});

		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({
			repo: GROUP_DID,
			collection: GROUP_DECLARATION_COLLECTION,
			rkey: 'self',
			intent: 'delete'
		});
		expect(writes[0].space).toBeUndefined();
	});

	it('writes nothing at all for a private group being created', async () => {
		await reconcileGroupDeclaration({
			db,
			env,
			group,
			visibility: 'private',
			callerDid: OWNER,
			writer,
			reader: authz,
			// A repo minted seconds ago cannot be holding a declaration, so the
			// create path is not charged a delete that can only be a no-op.
			declared: false
		});

		expect(writes).toEqual([]);
	});
});

describe('telling our index about a withdrawal', () => {
	const uri = `at://${GROUP_DID}/${GROUP_DECLARATION_COLLECTION}/${GROUP_DECLARATION_RKEY}`;

	beforeEach(() => {
		index.told = [];
		index.down = null;
	});
	afterEach(() => vi.restoreAllMocks());

	it('tells the index about the declaration once the PDS has deleted it', async () => {
		const toldBeforeDelete: number[] = [];
		await reconcileGroupDeclaration({
			db,
			env,
			group,
			visibility: 'private',
			callerDid: OWNER,
			reader: authz,
			writer: async (write) => {
				toldBeforeDelete.push(index.told.length);
				return writer(write);
			}
		});

		expect(toldBeforeDelete).toEqual([0]);
		expect(index.told).toEqual([uri]);
	});

	it('does not tell the index when the PDS delete fails', async () => {
		await expect(
			removeGroupDeclaration({
				db,
				env,
				group,
				callerDid: OWNER,
				reader: authz,
				writer: async () => {
					throw new Error('com.atproto.repo.deleteRecord failed: 502');
				}
			})
		).rejects.toThrow(/502/);
		expect(index.told).toEqual([]);
	});

	// By the time the index is told, the PDS has already deleted the record, but
	// browse still lists the group, and a save going private must not put new
	// text in the row while it does. A retry is safe: the PDS delete is a no-op.
	it('fails with DeclarationIndexError when the index cannot be told, after the delete landed', async () => {
		index.down = new Error('D1_ERROR: Network connection lost');

		const error = await removeGroupDeclaration({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			reader: authz
		}).catch((e: unknown) => e);

		expect(error).toBeInstanceOf(DeclarationIndexError);
		expect(String(error)).toContain('Network connection lost');
		expect(writes).toHaveLength(1);

		index.down = null;
		await removeGroupDeclaration({ db, env, group, callerDid: OWNER, writer, reader: authz });
		expect(index.told).toEqual([uri]);
	});
});

describe('every refusal comes before any write', () => {
	// Where the declaration may point is checked by the helper the about writer
	// shares, and ./about-writer.test.ts refuses each wrong space.
	it.each([
		// Announcing a group, or withdrawing it, changes its face: MANAGE_GROUP.
		[
			'a declaration from a member',
			() => writeGroupDeclaration({ db, env, group, callerDid: MEMBER, writer, reader: authz }),
			GroupPermissionError
		],
		[
			'a withdrawal from a member',
			() => removeGroupDeclaration({ db, env, group, callerDid: MEMBER, writer, reader: authz }),
			GroupPermissionError
		]
	] as const)('refuses %s', async (_case, run, refusal) => {
		await expect(run()).rejects.toBeInstanceOf(refusal);
		expect(writes).toEqual([]);
	});
});

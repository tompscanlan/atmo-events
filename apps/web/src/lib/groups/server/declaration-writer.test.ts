// The declaration writer. Three things here are worth a test:
//   * the record goes to the public repo, not a space. It is the only group
//     record that must be anonymously readable, so a stray `space` would make
//     the group undiscoverable while every "the record was written" assertion
//     still passed;
//   * a private group's declaration is deleted, not just left alone. Absence is
//     the signal, so a stale one keeps announcing a group that asked not to be;
//   * the gate is MANAGE_GROUP, since announcing a group changes its face.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import {
	reconcileGroupDeclaration,
	removeGroupDeclaration,
	writeGroupDeclaration
} from './declaration-writer';
import { GroupPermissionError, type GroupRepoWrite, type GroupRepoWriter } from './event-writer';
import { GroupRecordError } from './event-writer';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE, type GroupRow } from '../types';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { spaceUri } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';

const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;

// The writer takes an env only for GROUP_CREDENTIAL_KEY, and these cases inject
// their own writer, so it is never consulted.
const env = {};

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, MEMBER, 'member');
	await recordGroupSpaces(db, group.id, {
		aboutSpaceUri: ABOUT,
		membersSpaceUri: spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self')
	});
	group = { ...group, about_space_uri: ABOUT };

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return {
			uri: write.space
				? `${write.space}/${write.repo}/${write.collection}/${write.rkey}`
				: `at://${write.repo}/${write.collection}/${write.rkey}`,
			cid: 'bafytest'
		};
	};
});

afterEach(() => harness.close());

describe('writeGroupDeclaration', () => {
	it('writes to the PUBLIC REPO — no space — so an anonymous reader can fetch it', async () => {
		const result = await writeGroupDeclaration({ db, env, group, callerDid: OWNER, writer });

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

	it('carries the about space pointer and nothing that names the group', async () => {
		await writeGroupDeclaration({ db, env, group, callerDid: OWNER, writer });

		const record = writes[0].record as Record<string, unknown>;
		expect(record.aboutSpace).toBe(ABOUT);
		expect(typeof record.createdAt).toBe('string');
		// "Discovery only": a peer finds the group and asks the about space for
		// the rest. Anything renderable here would be a promise the space
		// refuses to keep for an anonymous caller.
		expect(Object.keys(record).sort()).toEqual(['$type', 'aboutSpace', 'createdAt']);
	});

	it('preserves the supplied date, so re-declaring does not restamp the group', async () => {
		await writeGroupDeclaration({
			db,
			env,
			group,
			callerDid: OWNER,
			writer,
			createdAt: '2026-01-02T03:04:05.000Z'
		});

		expect((writes[0].record as Record<string, unknown>).createdAt).toBe(
			'2026-01-02T03:04:05.000Z'
		);
	});

	it('refuses a group whose about space was never provisioned, rather than pointing nowhere', async () => {
		await expect(
			writeGroupDeclaration({
				db,
				env,
				group: { ...group, about_space_uri: null },
				callerDid: OWNER,
				writer
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(writes).toHaveLength(0);
	});

	it('requires MANAGE_GROUP', async () => {
		await expect(
			writeGroupDeclaration({ db, env, group, callerDid: MEMBER, writer })
		).rejects.toBeInstanceOf(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

describe('reconcileGroupDeclaration', () => {
	it('declares a public group', async () => {
		await reconcileGroupDeclaration({ db, env, group, callerDid: OWNER, writer });

		expect(writes).toHaveLength(1);
		expect(writes[0].intent).toBe('update');
	});

	it('DELETES the declaration when a group turns private', async () => {
		await reconcileGroupDeclaration({
			db,
			env,
			group: { ...group, visibility: 'private' },
			callerDid: OWNER,
			writer
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
			group: { ...group, visibility: 'private' },
			callerDid: OWNER,
			writer,
			// A repo minted seconds ago cannot be holding a declaration, so the
			// create path is not charged a delete that can only be a no-op.
			assumeAbsent: true
		});

		expect(writes).toEqual([]);
	});
});

describe('removeGroupDeclaration', () => {
	it('deletes without reading first — a missing record is a no-op at the PDS', async () => {
		await removeGroupDeclaration({ db, env, group, callerDid: OWNER, writer });

		expect(writes).toHaveLength(1);
		expect(writes[0].intent).toBe('delete');
	});

	it('requires MANAGE_GROUP, so a member cannot un-announce the group', async () => {
		await expect(
			removeGroupDeclaration({ db, env, group, callerDid: MEMBER, writer })
		).rejects.toBeInstanceOf(GroupPermissionError);
		expect(writes).toHaveLength(0);
	});
});

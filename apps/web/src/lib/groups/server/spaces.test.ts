import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';

import { GroupSpaceError, readGroupVisibility } from './spaces';

import { spaceUri } from '../ids';
import { GroupRecordError, pdsWriter } from './group-write';
import { hostDown, spaceReader } from './__fixtures__/space-reader';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	groupAccessRecord
} from '../members-record';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CRED = linkedCredential(GROUP_DID, 'https://pds.example.com');

let sent: { nsid: string; body: Record<string, unknown> }[];

beforeEach(() => {
	linkedCredential(GROUP_DID, 'https://pds.example.com');
	sent = [];
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const nsid = new URL(String(input)).pathname.replace('/xrpc/', '');
		sent.push({ nsid, body: init?.body ? JSON.parse(String(init.body)) : {} });
		return Response.json({ uri: `at://${GROUP_DID}/com.example.test/self`, cid: 'bafy' });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
});

describe('pdsWriter target', () => {
	const SPACE = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
	const record = { $type: 'com.example.test', value: 1 };

	it.each([
		[SPACE, 'update', 'com.atproto.space.putRecord'],
		[SPACE, 'create', 'com.atproto.space.createRecord'],
		[SPACE, 'delete', 'com.atproto.space.deleteRecord'],
		[undefined, 'update', 'com.atproto.repo.putRecord'],
		[undefined, 'delete', 'com.atproto.repo.deleteRecord']
	] as const)('a write in space %s with intent %s goes to %s', async (space, intent, nsid) => {
		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record,
			intent,
			...(space ? { space } : {})
		});

		expect(sent.map((s) => s.nsid)).toEqual([nsid]);
		expect(sent[0].body).toMatchObject({ repo: GROUP_DID, rkey: 'self' });
		if (space) expect(sent[0].body.space).toBe(space);
		else expect(sent[0].body).not.toHaveProperty('space');
	});
});

describe('pdsWriter refusals', () => {
	const SPACE = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');
	const create = (collection: string) =>
		pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection,
			rkey: 'did:plc:member',
			record: {},
			intent: 'create',
			space: SPACE
		});

	beforeEach(() => {
		vi.stubGlobal('fetch', async () =>
			Response.json(
				{ error: 'RecordAlreadyExists', message: 'Record already exists' },
				{ status: 400 }
			)
		);
	});

	it('says an admitted account is already a member, rather than replacing its roles', async () => {
		await expect(create(GROUP_MEMBERSHIP_COLLECTION)).rejects.toBeInstanceOf(GroupRecordError);
	});

	it('leaves an existing record of another kind a plain failure', async () => {
		const failure = await create('com.example.test').catch((e: unknown) => e);
		expect(failure).not.toBeInstanceOf(GroupRecordError);
	});
});

describe('readGroupVisibility', () => {
	const ABOUT = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'self');
	const group = { group_did: GROUP_DID, about_space_uri: ABOUT };

	const aboutAccess = (value: Record<string, unknown>) => ({
		space: ABOUT,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		value: { ...value, $type: GROUP_ACCESS_COLLECTION }
	});
	const saying = (isPublic: boolean) =>
		aboutAccess(
			groupAccessRecord({
				spaceType: ABOUT_SPACE_TYPE,
				roles: ABOUT_SPACE_READER_ROLES,
				public: isPublic
			})
		);

	it.each([
		[true, 'public'],
		[false, 'private']
	] as const)(
		'an access record with public: %s reads as %s, in one read',
		async (isPublic, visibility) => {
			const reader = spaceReader(GROUP_DID, { records: [saying(isPublic)] });

			expect(await readGroupVisibility(reader, group)).toBe(visibility);
			expect(reader.calls).toEqual([
				`get ${ABOUT} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`
			]);
		}
	);

	it.each([
		['no access record', []],
		['a record with no grants list', [aboutAccess({ public: true })]]
	] as const)('%s reads as private', async (_case, records) => {
		const reader = spaceReader(GROUP_DID, { records: [...records] });
		expect(await readGroupVisibility(reader, group)).toBe('private');
	});

	it('throws when the record cannot be read', async () => {
		const reader = spaceReader(GROUP_DID, { records: [saying(true)], fail: hostDown(502) });

		await expect(readGroupVisibility(reader, group)).rejects.toThrow();
	});

	it('throws for a group with no about space yet, before reading anything', async () => {
		const reader = spaceReader(GROUP_DID);

		await expect(
			readGroupVisibility(reader, { group_did: GROUP_DID, about_space_uri: null })
		).rejects.toThrow(GroupSpaceError);
		expect(reader.calls).toEqual([]);
	});
});

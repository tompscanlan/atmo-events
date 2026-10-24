// The write target, and the group's visibility.
//
// The mistake these cases guard against mirrors the write gate's. The gate
// stops a group's events being authored by an admin; this stops a group's
// control plane being written to the group's public repo. A members record in
// the public repo is anonymously readable and indexable, which is the leak the
// two-space split exists to prevent. It would also pass every permission check,
// because the permission is not what is wrong. Only the target is.
//
// These use `pdsWriter` rather than an injected seam, because the method choice
// is made inside it. An injected writer would only assert the test's own
// fixture.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from '../types';
import { linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';

import { GroupSpaceError, readGroupVisibility } from './spaces';

import { POLICY_MEMBER_LIST, POLICY_PUBLIC, spaceUri } from '../ids';
import { pdsWriter } from './group-write';
import { hostDown, spaceReader } from './__fixtures__/space-reader';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '../members-record';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const CRED = linkedCredential(GROUP_DID, 'https://pds.example.com');

interface Sent {
	nsid: string;
	body: Record<string, unknown>;
}

let sent: Sent[];
/** Per-NSID responses. A missing entry answers `{}` with 200, so a case only
 *  states the responses it cares about. */
let replies: Record<string, { status: number; body: unknown }>;

beforeEach(() => {
	linkedCredential(GROUP_DID, 'https://pds.example.com');
	sent = [];
	replies = {};
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const nsid = url.pathname.replace('/xrpc/', '');
		const body = init?.body ? JSON.parse(String(init.body)) : {};
		sent.push({ nsid, body });

		const reply = replies[nsid];
		if (reply) {
			return Response.json(reply.body, { status: reply.status });
		}
		return Response.json({});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	unlinkAllGroups();
});

const writes = () => sent.filter((s) => !s.nsid.startsWith('com.atproto.server.'));

describe('pdsWriter target', () => {
	const record = { $type: 'com.example.test', value: 1 };

	it('sends a space write to com.atproto.space.putRecord carrying both space and repo', async () => {
		const space = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'kona');
		replies['com.atproto.space.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record,
			intent: 'update',
			space
		});

		expect(writes()).toHaveLength(1);
		expect(writes()[0].nsid).toBe('com.atproto.space.putRecord');
		// `repo` stays the group: the space scopes access, it does not reparent.
		expect(writes()[0].body).toEqual({
			space,
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record
		});
	});

	it('sends a repo write to com.atproto.repo.putRecord with no space field', async () => {
		replies['com.atproto.repo.putRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/self`, cid: 'bafy' }
		};

		await pdsWriter(
			CRED,
			GROUP_DID
		)({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'self',
			record,
			intent: 'update'
		});

		expect(writes()[0].nsid).toBe('com.atproto.repo.putRecord');
		expect(writes()[0].body).not.toHaveProperty('space');
	});

	it('routes create and delete by target too', async () => {
		const space = spaceUri(GROUP_DID, ABOUT_SPACE_TYPE, 'kona');
		replies['com.atproto.space.createRecord'] = {
			status: 200,
			body: { uri: `at://${GROUP_DID}/com.example.test/new`, cid: 'bafy' }
		};
		const write = pdsWriter(CRED, GROUP_DID);

		await write({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'new',
			record,
			intent: 'create',
			space
		});
		await write({
			repo: GROUP_DID,
			collection: 'com.example.test',
			rkey: 'new',
			record: {},
			intent: 'delete',
			space
		});

		expect(writes().map((w) => w.nsid)).toEqual([
			'com.atproto.space.createRecord',
			'com.atproto.space.deleteRecord'
		]);
	});
});

// The group's visibility is its about space's `access.public`, the record that is
// the policy, not the read policy the host holds, which follows it. Reading it is
// one record read with the group's session. (Spec: FR-214.)
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
		'an about space access record with public: %s reads as %s, whatever the host holds',
		async (isPublic, visibility) => {
			// The host's policy says the opposite: the record decides, and the host
			// is not asked.
			const reader = spaceReader(GROUP_DID, {
				records: [saying(isPublic)],
				policies: { [ABOUT]: isPublic ? POLICY_MEMBER_LIST : POLICY_PUBLIC }
			});

			expect(await readGroupVisibility(reader, group)).toBe(visibility);
			expect(reader.calls).toEqual([
				`get ${ABOUT} ${GROUP_DID} ${GROUP_ACCESS_COLLECTION} ${GROUP_ACCESS_RKEY}`
			]);
		}
	);

	it('a group with no about space access record reads as private, even with a public host', async () => {
		const reader = spaceReader(GROUP_DID, { policies: { [ABOUT]: POLICY_PUBLIC } });

		expect(await readGroupVisibility(reader, group)).toBe('private');
	});

	it('a record with no grants list is not an access record, so it reads as private', async () => {
		const reader = spaceReader(GROUP_DID, { records: [aboutAccess({ public: true })] });

		expect(await readGroupVisibility(reader, group)).toBe('private');
	});

	it('throws when the record cannot be read, so "could not ask" is neither answer', async () => {
		const reader = spaceReader(GROUP_DID, { records: [saying(true)], fail: hostDown(502) });

		await expect(readGroupVisibility(reader, group)).rejects.toThrow('502');
	});

	it('throws for a group with no about space yet, before reading anything', async () => {
		const reader = spaceReader(GROUP_DID);

		await expect(
			readGroupVisibility(reader, { group_did: GROUP_DID, about_space_uri: null })
		).rejects.toThrow(GroupSpaceError);
		expect(reader.calls).toEqual([]);
	});
});

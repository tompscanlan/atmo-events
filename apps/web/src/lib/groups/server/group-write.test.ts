import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The write gate. The group's host decides every write as the group, so the
// gate checks only a write to this app's own rows, which the host never sees.
// For those it asks the group's records for the caller's standing once per
// request: every write a request makes passes the request's one reader, so a
// save that writes several rows reads the standing once.
import type { GroupRow } from '../types';
import type { GroupSpaceReader } from './about-read';
import { hostDown, type FakeSpaceReader } from './__fixtures__/space-reader';
import { authzReader } from './__fixtures__/members-space';
import type { SqliteD1 } from './__fixtures__/d1-sqlite';
import { seedGroup } from './__fixtures__/seed-group';
import {
	GroupPermissionError,
	requireGroupPermission,
	requireGroupWrite,
	requireMembershipWrite
} from './group-write';
import { spaceWrite } from '../grants';
import { GROUP_PROFILE_COLLECTION } from '../about-record';
import { ABOUT_SPACE_TYPE } from '../types';

const GROUP_DID = 'did:plc:gatetestgroupaaaaaaaaaaa';
const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const ADMIN = 'did:plc:admin';

let harness: SqliteD1;
let group: GroupRow;

beforeEach(async () => {
	({ harness, group } = await seedGroup({
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona',
		members: { [MEMBER]: 'member' }
	}));
});

afterEach(() => harness.close());

/** A host whose members space holds the records a create leaves, and whose call
 *  log counts the reads. `failFirst` fails the first read. */
function countingReader({ failFirst = false } = {}): FakeSpaceReader {
	const reader = authzReader(
		GROUP_DID,
		{ [OWNER]: 'admin', [ADMIN]: 'admin', [MEMBER]: 'member' },
		{ fail: (call) => (failFirst && reader.calls.length === 1 ? hostDown(502)(call) : undefined) }
	);
	return reader;
}

const gate = (reader: GroupSpaceReader, callerDid: string) => ({
	db: harness.db,
	env: {},
	group,
	callerDid,
	reader
});

// A write to this app's own rows: the one kind the gate checks itself.
const appOnly = { appOnly: true };

describe('the standing the gate reads', () => {
	const profile = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');
	const rules = spaceWrite(ABOUT_SPACE_TYPE, 'group.opensocial.rule', 'create');

	it('reads the caller’s standing once for every write that shares a reader', async () => {
		const reader = countingReader();
		await requireGroupWrite(gate(reader, OWNER), profile, appOnly);
		const once = reader.calls.length;
		expect(once).toBeGreaterThan(0);

		await requireGroupWrite(gate(reader, OWNER), profile, appOnly);
		await requireGroupWrite(gate(reader, OWNER), rules, appOnly);
		expect(reader.calls.length).toBe(once);
	});

	it('reads again for another caller, or for another request’s reader', async () => {
		const reader = countingReader();
		await requireGroupWrite(gate(reader, OWNER), profile, appOnly);
		const once = reader.calls.length;

		// The member's standing is read afresh; their refusal may also read the
		// about space's `access`, which the owner's write never needed.
		await expect(requireGroupWrite(gate(reader, MEMBER), profile, appOnly)).rejects.toThrow(
			GroupPermissionError
		);
		expect(reader.calls.length).toBeGreaterThanOrEqual(2 * once);

		const next = countingReader();
		await requireGroupWrite(gate(next, OWNER), profile, appOnly);
		expect(next.calls.length).toBe(once);
	});

	it('does not keep a failed read, so the next write asks again', async () => {
		const reader = countingReader({ failFirst: true });
		await expect(requireGroupWrite(gate(reader, OWNER), profile, appOnly)).rejects.toThrow(
			/failed: 502/
		);
		await expect(requireGroupWrite(gate(reader, OWNER), profile, appOnly)).resolves.toBeUndefined();
	});
});

// A write to this app's own rows is checked against the caller's scopes, as the
// host would check a write as the group. (Spec: FR-213.)
describe('requireGroupWrite, for this app’s own rows', () => {
	const profile = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');

	it("lets a write through when a role's scope covers it, and refuses it otherwise", async () => {
		await expect(
			requireGroupWrite(gate(countingReader(), ADMIN), profile, appOnly)
		).resolves.toBeUndefined();
		await expect(
			requireGroupWrite(gate(countingReader(), MEMBER), profile, appOnly)
		).rejects.toMatchObject({
			reason: `your roles hold no scope to update ${GROUP_PROFILE_COLLECTION} records in the ${ABOUT_SPACE_TYPE} space`
		});
	});

	// The standing reads only the members space. A grant in another space's
	// `access` is read when a write there needs it, and not before.
	it("reads a target space's access only for a write permissions does not allow", async () => {
		const about = `at://${GROUP_DID}/space/${ABOUT_SPACE_TYPE}/self`;
		const reader = countingReader();
		reader.put({
			space: about,
			collection: 'group.opensocial.access',
			rkey: 'self',
			value: {
				public: true,
				grants: [
					{
						role: 'member',
						scopes: [`space:${ABOUT_SPACE_TYPE}?collection=${GROUP_PROFILE_COLLECTION}`]
					}
				]
			}
		});
		await requireGroupWrite(gate(reader, ADMIN), profile, appOnly);
		expect(reader.callsIn(about)).toEqual([]);

		await expect(
			requireGroupWrite(gate(reader, MEMBER), profile, appOnly)
		).resolves.toBeUndefined();
		expect(reader.callsIn(about)).toHaveLength(1);
	});

	it('lets the group itself through with nothing read', async () => {
		const reader = countingReader();
		await requireGroupWrite(gate(reader, GROUP_DID), profile, appOnly);
		expect(reader.calls).toEqual([]);
	});
});

// The group's host cuts each session to its person's roles and checks
// `assignable`, so the gate asks nothing about a write as the group and the
// refusal a person sees is the host's. (Spec: FR-213, SC-503.)
describe('a write as the group', () => {
	const profile = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');
	const anonymous = (reader: GroupSpaceReader) => ({
		...gate(reader, OWNER),
		callerDid: null
	});

	it('is the host’s to decide: a member’s writes pass the gate with nothing read', async () => {
		const reader = countingReader();
		await expect(requireGroupWrite(gate(reader, MEMBER), profile)).resolves.toBeUndefined();
		await expect(requireMembershipWrite(gate(reader, MEMBER), [])).resolves.toBeUndefined();
		await expect(
			requireGroupPermission(gate(reader, MEMBER), 'MANAGE_EVENTS')
		).resolves.toBeUndefined();
		expect(reader.calls).toEqual([]);
	});

	it('still refuses an anonymous caller, who has nothing to send the write as', async () => {
		await expect(requireGroupWrite(anonymous(countingReader()), profile)).rejects.toThrow(
			GroupPermissionError
		);
		await expect(
			requireMembershipWrite(anonymous(countingReader()), ['member'])
		).rejects.toMatchObject({
			reason:
				'your roles hold no scope to create group.opensocial.membership records in the group.opensocial.members space'
		});
		await expect(
			requireGroupPermission(anonymous(countingReader()), 'MANAGE_EVENTS')
		).rejects.toMatchObject({ reason: 'MANAGE_EVENTS required' });
	});
});

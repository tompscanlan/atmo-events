import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The write gate asks the group's records for the caller's standing once per
// request: every write a request makes passes the request's one reader, so a
// create or a settings save that writes nine records reads the standing once.
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
import { GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
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
		{ [OWNER]: 'owner', [ADMIN]: 'admin', [MEMBER]: 'member' },
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

describe('requireGroupPermission', () => {
	it('reads the caller’s standing once for every write that shares a reader', async () => {
		const reader = countingReader();
		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		const once = reader.calls.length;
		expect(once).toBeGreaterThan(0);

		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		await requireGroupPermission(gate(reader, OWNER), 'CREATE_EVENT');
		expect(reader.calls.length).toBe(once);
	});

	it('reads again for another caller, or for another request’s reader', async () => {
		const reader = countingReader();
		await requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP');
		const once = reader.calls.length;

		await expect(requireGroupPermission(gate(reader, MEMBER), 'MANAGE_GROUP')).rejects.toThrow(
			GroupPermissionError
		);
		expect(reader.calls.length).toBe(2 * once);

		const next = countingReader();
		await requireGroupPermission(gate(next, OWNER), 'MANAGE_GROUP');
		expect(next.calls.length).toBe(once);
	});

	it('does not keep a failed read, so the next write asks again', async () => {
		const reader = countingReader({ failFirst: true });
		await expect(requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP')).rejects.toThrow(
			/failed: 502/
		);
		await expect(
			requireGroupPermission(gate(reader, OWNER), 'MANAGE_GROUP')
		).resolves.toBeUndefined();
	});
});

// Every write as the group is checked against the caller's scopes, and a
// membership write also against the roles their grants may assign. (Spec: FR-213.)
describe('requireGroupWrite', () => {
	const profile = spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update');

	it("lets a write through when a role's scope covers it, and refuses it otherwise", async () => {
		await expect(
			requireGroupWrite(gate(countingReader(), ADMIN), profile)
		).resolves.toBeUndefined();
		await expect(requireGroupWrite(gate(countingReader(), MEMBER), profile)).rejects.toMatchObject({
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
		await requireGroupWrite(gate(reader, ADMIN), profile);
		expect(reader.callsIn(about)).toEqual([]);

		await expect(requireGroupWrite(gate(reader, MEMBER), profile)).resolves.toBeUndefined();
		expect(reader.callsIn(about)).toHaveLength(1);
	});

	it('lets the group itself through with nothing read', async () => {
		const reader = countingReader();
		await requireGroupWrite(gate(reader, GROUP_DID), profile);
		expect(reader.calls).toEqual([]);
	});
});

describe('requireMembershipWrite', () => {
	it('lets an admin admit a member and promote one to admin', async () => {
		await expect(
			requireMembershipWrite(gate(countingReader(), ADMIN), 'did:plc:newcomer', ['member'])
		).resolves.toBeUndefined();
		await expect(
			requireMembershipWrite(gate(countingReader(), ADMIN), MEMBER, ['admin'])
		).resolves.toBeUndefined();
	});

	// The owner is on no admin's `assignable`, so an admin can neither make an
	// owner nor remove one: the record says what the owner holds, whatever the row.
	it("refuses an admin any change that touches the owner's role", async () => {
		await expect(
			requireMembershipWrite(gate(countingReader(), ADMIN), MEMBER, ['owner'])
		).rejects.toMatchObject({ reason: 'your roles may not assign or remove owner' });
		const reader = countingReader();
		await expect(requireMembershipWrite(gate(reader, ADMIN), OWNER, [])).rejects.toMatchObject({
			reason: 'your roles may not assign or remove owner'
		});
		// The owner's record was read for the roles it would remove.
		expect(
			reader.calls.some((call) => call.endsWith(`${GROUP_MEMBERSHIP_COLLECTION} ${OWNER}`))
		).toBe(true);
	});

	it('refuses a member any membership write, naming the scope', async () => {
		await expect(
			requireMembershipWrite(gate(countingReader(), MEMBER), 'did:plc:newcomer', ['member'])
		).rejects.toMatchObject({
			reason: `your roles hold no scope to create ${GROUP_MEMBERSHIP_COLLECTION} records in the group.opensocial.members space`
		});
	});
});

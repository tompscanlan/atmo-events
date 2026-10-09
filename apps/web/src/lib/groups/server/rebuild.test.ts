// The rebuild against a real SQLite with the real schema and triggers: delete a
// group's rows, rebuild from the DID, and compare what comes back with what the
// app itself wrote. The records are built by the same builders the writers use,
// and the reader keeps the two spaces apart, because a cold rebuild reads the
// profile from one and the roster from the other.
//
// Over a surviving row, two more rules hold. The roster rebuild is additive: a
// row with no record is the trace of a roster act whose second half failed
// (`roster.ts`), the gate already denies it, and a rebuild that deleted it would
// be guessing which failure it was. And the owner's row is immutable in SQL, so
// the rebuild inserts a missing one and does not fight one that disagrees.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { spaceReader, type SpaceRecordInput } from './__fixtures__/space-reader';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord,
	type GroupJoinPolicy
} from '../about-record';
import {
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord
} from '../members-record';
import { DEFAULT_ROLE_PERMISSIONS, type GroupRoleName } from '../permissions';
import type { GroupRow } from '../types';
import {
	GroupRebuildRefused,
	rebuildGroup,
	rebuildGroupCache,
	rebuildGroupMembers
} from './rebuild';

import { groupSpaceUris } from '../ids';
import { seedGroup } from './__fixtures__/seed-group';
import { getGroupById } from './db/groups';
import { listMembers } from './db/roster';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const ADMIN = 'did:plc:6cz6dldz42itymdbte47ewcv';
const MEMBER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;
let db: D1Database;

/** A reader over records in both spaces. Each record names its space, and the
 *  reader keeps them apart: a profile answered out of the members space would
 *  pass a rebuild that read the wrong space. */
const readerOver = (records: SpaceRecordInput[]) => spaceReader(GROUP_DID, { records });

const iso = (ms: number) => new Date(ms).toISOString();

function profile(joinPolicy: GroupJoinPolicy, createdAt: number): SpaceRecordInput {
	return {
		space: ABOUT,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY,
		value: {
			...groupProfileRecord({
				name: 'Kona Surf Club',
				description: 'Dawn patrol, every day',
				joinPolicy,
				locationName: 'Kailua-Kona',
				createdAt: iso(createdAt)
			}),
			$type: GROUP_PROFILE_COLLECTION
		}
	};
}

const rule: SpaceRecordInput = {
	space: ABOUT,
	collection: GROUP_RULE_COLLECTION,
	rkey: '3lrule00000001',
	value: {
		...groupRuleRecord({ text: 'Leave no trace', order: 0 }),
		$type: GROUP_RULE_COLLECTION
	}
};

function membership(did: string, role: GroupRoleName, createdAt: number): SpaceRecordInput {
	return {
		space: MEMBERS,
		collection: GROUP_MEMBERSHIP_COLLECTION,
		rkey: did,
		value: {
			...groupMembershipRecord({ subject: did, roles: [role], createdAt: iso(createdAt) }),
			$type: GROUP_MEMBERSHIP_COLLECTION
		}
	};
}

/** The authz config a create writes: a `role` record per seeded role and both
 *  binding records over the seeded bundles. */
const AUTHZ: SpaceRecordInput[] = [
	...(['owner', 'admin', 'member'] as const).map((id) => ({
		space: MEMBERS,
		collection: GROUP_ROLE_COLLECTION,
		rkey: id,
		value: { ...groupRoleRecord({ id }), $type: GROUP_ROLE_COLLECTION }
	})),
	...(['community', 'modality'] as const).map((altitude) => {
		const collection =
			altitude === 'community' ? GROUP_PERMISSIONS_COLLECTION : GROUP_EVENT_PERMISSIONS_COLLECTION;
		return {
			space: MEMBERS,
			collection,
			rkey: GROUP_PERMISSIONS_RKEY,
			value: {
				...groupBindingsRecord({ altitude, bundles: DEFAULT_ROLE_PERMISSIONS }),
				$type: collection
			}
		};
	})
];

/** Everything a rebuild must bring back, with the local surrogates (ids and
 *  the cache timestamp) left out because a rebuild regenerates them. */
async function snapshot(groupDid: string) {
	const row = await db
		.prepare(`SELECT * FROM groups WHERE group_did = ?`)
		.bind(groupDid)
		.first<GroupRow & Record<string, unknown>>();
	if (!row) return null;
	const { id } = row;
	const columns: Record<string, unknown> = { ...row };
	delete columns.id;
	delete columns.updated_at;
	const roster = await db
		.prepare(
			`SELECT m.did, r.name AS role, m.created_at FROM memberships m
			 JOIN roles r ON r.id = m.role_id WHERE m.group_id = ? ORDER BY m.did`
		)
		.bind(id)
		.all();
	const grants = await db
		.prepare(
			`SELECT r.name AS role, rp.permission FROM roles r
			 LEFT JOIN role_permissions rp ON rp.role_id = r.id
			 WHERE r.group_id = ? ORDER BY r.name, rp.permission`
		)
		.bind(id)
		.all();
	return { columns, roster: roster.results, grants: grants.results };
}

const count = async (table: string) =>
	(await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

/** Deletes every row the group has: the cascade takes its roles, bundles and
 *  roster with it. The group's linked session is kept by DID outside D1, so it
 *  survives, as a rebuild expects. */
async function dropGroupRows(groupId: string) {
	await db.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();
}

/** A group the app created, with its records written to match. */
async function appGroup(
	requireApproval: boolean
): Promise<{ row: GroupRow; records: SpaceRecordInput[] }> {
	const { group: row } = await seedGroup({
		harness,
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Surf Club',
		description: 'Dawn patrol, every day',
		requireApproval,
		locationName: 'Kailua-Kona',
		members: { [ADMIN]: 'admin', [MEMBER]: 'member' }
	});

	const joined = await db
		.prepare(`SELECT did, created_at FROM memberships WHERE group_id = ?`)
		.bind(row.id)
		.all<{ did: string; created_at: number }>();
	const at = new Map((joined.results ?? []).map((m) => [m.did, m.created_at]));
	return {
		row,
		records: [
			profile(requireApproval ? 'approval' : 'open', row.created_at),
			rule,
			...AUTHZ,
			membership(OWNER, 'owner', at.get(OWNER)!),
			membership(ADMIN, 'admin', at.get(ADMIN)!),
			membership(MEMBER, 'member', at.get(MEMBER)!)
		]
	};
}

beforeEach(() => {
	harness = sqliteD1();
	db = harness.db;
});

afterEach(() => harness.close());

describe('rebuildGroup: a group with no row', () => {
	it('restores the row, the roles, their bundles and the roster the app wrote', async () => {
		const { row, records } = await appGroup(true);
		const before = await snapshot(GROUP_DID);
		await dropGroupRows(row.id);
		expect(await snapshot(GROUP_DID)).toBeNull();

		const result = await rebuildGroup(db, readerOver(records), GROUP_DID);

		expect(result.path).toBe('restored');
		expect(await snapshot(GROUP_DID)).toEqual(before);
		// The owner went in with the row; the projection restored the other two.
		expect(result.members.unchanged).toEqual([OWNER]);
		expect(result.members.restored.sort()).toEqual([ADMIN, MEMBER].sort());
	});

	// Each refusal comes before any write. The owner one matters most: owner_did
	// can never be corrected once written, so a guessed owner is permanent.
	it.each([
		[
			'no membership record grants owner',
			'no-owner-record',
			(r: SpaceRecordInput) => r.rkey !== OWNER
		],
		[
			'there is no profile record, so no name to restore',
			'no-profile',
			(r: SpaceRecordInput) => r.collection !== GROUP_PROFILE_COLLECTION
		],
		[
			'there are no authz records, so no member could be projected',
			'no-authz-records',
			(r: SpaceRecordInput) => !AUTHZ.includes(r)
		]
	] as const)('refuses, and writes nothing, when %s', async (_case, reason, keep) => {
		const { row, records } = await appGroup(true);
		await dropGroupRows(row.id);

		const refusal = await rebuildGroup(db, readerOver(records.filter(keep)), GROUP_DID).catch(
			(e) => e
		);

		expect(refusal).toBeInstanceOf(GroupRebuildRefused);
		expect(refusal.reason).toBe(reason);
		for (const table of ['groups', 'roles', 'role_permissions', 'memberships']) {
			expect(await count(table)).toBe(0);
		}
	});
});

describe('rebuildGroup: a surviving row', () => {
	it('is repaired in place rather than restored', async () => {
		const { row, records } = await appGroup(true);
		await db.prepare(`UPDATE groups SET name = 'drifted' WHERE id = ?`).bind(row.id).run();

		const result = await rebuildGroup(db, readerOver(records), GROUP_DID);

		expect(result.path).toBe('repaired');
		expect(result.group.id).toBe(row.id);
		expect(result.group.name).toBe('Kona Surf Club');
	});
});

// Cache repair over a surviving row: the columns the profile record owns.
describe('rebuildGroupCache', () => {
	/** A row whose every profile column has drifted from the record. */
	const staleGroup = async () =>
		(
			await seedGroup({
				harness,
				groupDid: GROUP_DID,
				ownerDid: OWNER,
				name: 'Stale name',
				description: 'Stale description',
				locationName: 'Stale location'
			})
		).group;

	// The row's approval is a cache of the profile's join policy, `open`
	// included. owner_did is owned by no record, so it must survive untouched.
	it('overwrites every column the profile owns, and leaves owner_did alone', async () => {
		const group = await staleGroup();

		const result = await rebuildGroupCache(db, readerOver([profile('open', 0), rule]), group);

		expect(result).toEqual({ outcome: 'repaired', rules: 1 });
		expect(await getGroupById(db, group.id)).toMatchObject({
			name: 'Kona Surf Club',
			description: 'Dawn patrol, every day',
			location_name: 'Kailua-Kona',
			require_approval: 0,
			owner_did: OWNER
		});
	});

	// An empty about space is not "the group has no name": wiping the cache to
	// match an absent record would destroy the only copy.
	it('leaves the cache alone when there is no profile record', async () => {
		const group = await staleGroup();

		const result = await rebuildGroupCache(db, readerOver([]), group);

		expect(result.outcome).toBe('no-profile');
		expect(await getGroupById(db, group.id)).toMatchObject({ name: 'Stale name' });
	});
});

// The roster half of a repair over a surviving row: additive, and never at war
// with the owner's row.
describe('rebuildGroupMembers', () => {
	it('corrects a row whose role drifted from its record', async () => {
		const { row, records } = await appGroup(true);
		await db
			.prepare(
				`UPDATE memberships SET role_id = (SELECT id FROM roles WHERE group_id = ? AND name = 'member')
				 WHERE group_id = ? AND did = ?`
			)
			.bind(row.id, row.id, ADMIN)
			.run();

		const result = await rebuildGroupMembers(db, readerOver(records), row);

		expect(result.restored).toEqual([ADMIN]);
		expect((await listMembers(db, row.id)).find((m) => m.did === ADMIN)?.role).toBe('admin');
	});

	// A revocation whose row delete failed after its record went: the space no
	// longer names them, the row still does.
	it('reports a row with no record as an orphan and leaves the row', async () => {
		const { row, records } = await appGroup(true);
		const revoked = records.filter((r) => r.rkey !== MEMBER);

		const result = await rebuildGroupMembers(db, readerOver(revoked), row);

		expect(result.orphans).toEqual([MEMBER]);
		expect((await listMembers(db, row.id)).some((m) => m.did === MEMBER)).toBe(true);
	});

	// A record claiming the owner is merely an admin: the schema pins the owner
	// role to groups.owner_did, so this can only be reported.
	it('refuses to fight the immutable owner row when a record disagrees with it', async () => {
		const { row, records } = await appGroup(true);
		const demoted = records.map((r) => (r.rkey === OWNER ? membership(OWNER, 'admin', 0) : r));

		const result = await rebuildGroupMembers(db, readerOver(demoted), row);

		expect(result.skipped.map((s) => s.did)).toEqual([OWNER]);
		expect((await listMembers(db, row.id)).find((m) => m.did === OWNER)?.role).toBe('owner');
	});
});

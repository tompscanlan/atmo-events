// The rebuild against a real SQLite with the real schema and triggers: delete a
// group's rows, rebuild from the DID, and compare what comes back with what the
// app itself wrote. The records are built by the same builders the writers use,
// and the reader keeps the two spaces apart, because a cold rebuild reads the
// profile from one and the roster from the other.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import type { GroupSpaceReader } from './about-read';
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
import * as rebuildModule from './rebuild';
import { GroupRebuildRefused, rebuildGroup } from './rebuild';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import { groupSpaceUris } from './spaces';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const ADMIN = 'did:plc:6cz6dldz42itymdbte47ewcv';
const MEMBER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;
let db: D1Database;

interface Stored {
	space: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

/** A reader over a fixed record set that honors `space`, unlike the roster
 *  tests' fixture: a profile answered out of the members space would pass a
 *  rebuild that read the wrong space. `readPolicy` is the about space's, for a
 *  case whose rebuild asks the host; without it the host does not answer. */
function readerOver(records: Stored[], readPolicy?: string): GroupSpaceReader {
	const all = records.map((r) => ({
		...r,
		uri: `${r.space}/${GROUP_DID}/${r.collection}/${r.rkey}`,
		cid: 'bafytest'
	}));
	return {
		async get(q) {
			return (
				all.find(
					(r) => r.space === q.space && r.collection === q.collection && r.rkey === q.rkey
				) ?? null
			);
		},
		async list(q) {
			return all.filter(
				(r) => r.space === q.space && (!q.collection || r.collection === q.collection)
			);
		},
		async getSpace(space) {
			if (readPolicy && space === ABOUT) return { readPolicy };
			throw new Error('this fake holds records, not a space configuration');
		}
	};
}

const iso = (ms: number) => new Date(ms).toISOString();

function profile(joinPolicy: GroupJoinPolicy, createdAt: number): Stored {
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

const rule: Stored = {
	space: ABOUT,
	collection: GROUP_RULE_COLLECTION,
	rkey: '3lrule00000001',
	value: {
		...groupRuleRecord({ text: 'Leave no trace', order: 0 }),
		$type: GROUP_RULE_COLLECTION
	}
};

function membership(did: string, role: GroupRoleName, createdAt: number): Stored {
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
const AUTHZ: Stored[] = [
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
			`SELECT m.did, r.name AS role, m.status, m.created_at FROM memberships m
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
 *  roster with it. The credential table is keyed by DID and is not touched, so
 *  this leaves every row but the credential, as a rebuild expects. */
async function dropGroupRows(groupId: string) {
	await db.prepare(`DELETE FROM groups WHERE id = ?`).bind(groupId).run();
}

/** A group the app created, with its records written to match. */
async function appGroup(requireApproval: boolean): Promise<{ row: GroupRow; records: Stored[] }> {
	const row = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona Surf Club',
		description: 'Dawn patrol, every day',
		requireApproval,
		locationName: 'Kailua-Kona'
	});
	await addMember(db, row.id, ADMIN, 'admin');
	await addMember(db, row.id, MEMBER, 'member');
	await recordGroupSpaces(db, row.id, { aboutSpaceUri: ABOUT, membersSpaceUri: MEMBERS });

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

const sources = (records: Stored[], declared: boolean) => ({
	reader: readerOver(records),
	declared: async () => declared
});

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

		const result = await rebuildGroup(db, sources(records, true), GROUP_DID);

		expect(result.path).toBe('restored');
		expect(await snapshot(GROUP_DID)).toEqual(before);
		// The owner went in with the row; the projection restored the other two.
		expect(result.members.unchanged).toEqual([OWNER]);
		expect(result.members.restored.sort()).toEqual([ADMIN, MEMBER].sort());
	});

	it('refuses, and writes nothing, when no membership record grants owner', async () => {
		const { row, records } = await appGroup(true);
		await dropGroupRows(row.id);
		const ownerless = records.filter((r) => r.rkey !== OWNER);

		const refusal = await rebuildGroup(db, sources(ownerless, true), GROUP_DID).catch((e) => e);

		expect(refusal).toBeInstanceOf(GroupRebuildRefused);
		expect(refusal.reason).toBe('no-owner-record');
		for (const table of ['groups', 'roles', 'role_permissions', 'memberships']) {
			expect(await count(table)).toBe(0);
		}
	});

	it('refuses with no profile record, since there is no name to restore', async () => {
		const { row, records } = await appGroup(true);
		await dropGroupRows(row.id);
		const nameless = records.filter((r) => r.collection !== GROUP_PROFILE_COLLECTION);

		const refusal = await rebuildGroup(db, sources(nameless, true), GROUP_DID).catch((e) => e);

		expect(refusal.reason).toBe('no-profile');
		expect(await count('groups')).toBe(0);
	});

	it('refuses with no authz records, since no member could be projected', async () => {
		const { row, records } = await appGroup(true);
		await dropGroupRows(row.id);
		const unbound = records.filter((r) => !AUTHZ.includes(r));

		const refusal = await rebuildGroup(db, sources(unbound, true), GROUP_DID).catch((e) => e);

		expect(refusal.reason).toBe('no-authz-records');
		expect(await count('groups')).toBe(0);
	});
});

// Visibility is not restored, because there is nothing to restore it into: it
// is the about space's read policy at the host, and the declaration is already
// in the public repo. So a cold rebuild neither reads the declaration nor maps
// its presence onto anything.
describe('rebuildGroup: visibility stays at the host', () => {
	it('a rebuild does not derive visibility', async () => {
		const { row, records } = await appGroup(false);
		await dropGroupRows(row.id);
		let probed = 0;

		const result = await rebuildGroup(
			db,
			{
				reader: readerOver(records),
				declared: async () => {
					probed++;
					return false;
				}
			},
			GROUP_DID
		);

		expect(result.path).toBe('restored');
		expect(probed).toBe(0);
		expect(result.group).not.toHaveProperty('visibility');
		// The profile's join policy round-trips, and nothing overrides it.
		expect(result.group.require_approval).toBe(0);
		// Nor is there a helper left that maps placement onto a visibility.
		expect(Object.keys(rebuildModule).filter((name) => /visibility/i.test(name))).toEqual([]);
	});
});

describe('rebuildGroup: a surviving row', () => {
	it('is repaired in place rather than restored', async () => {
		const { row, records } = await appGroup(true);
		await db.prepare(`UPDATE groups SET name = 'drifted' WHERE id = ?`).bind(row.id).run();

		const result = await rebuildGroup(db, sources(records, true), GROUP_DID);

		expect(result.path).toBe('repaired');
		expect(result.group.id).toBe(row.id);
		expect(result.group.name).toBe('Kona Surf Club');
	});

	// The row's approval is a plain cache of the profile's join policy. A
	// private group is invite-only because its host says private, which the
	// page derives (`groupFace`), not because the row is forced to 1: any client
	// can move the host's read policy without touching this row.
	it('the group cache follows the profile join policy, with no private override', async () => {
		const { row, records } = await appGroup(false);
		await db.prepare(`UPDATE groups SET require_approval = 1 WHERE id = ?`).bind(row.id).run();

		const result = await rebuildGroup(
			db,
			{
				reader: readerOver(records, 'com.atproto.simplespace.defs#memberListPolicy'),
				declared: async () => false
			},
			GROUP_DID
		);

		expect(result.path).toBe('repaired');
		expect(result.group.id).toBe(row.id);
		expect(result.group.require_approval).toBe(0);
	});
});

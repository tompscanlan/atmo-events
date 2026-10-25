import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyGroupsSchemaSync, GROUPS_SCHEMA_STATEMENTS } from './schema';
import groupsSql from '../../../../migrations/0001_groups.sql?raw';
import { sqliteD1 } from './__fixtures__/d1-sqlite';

let db: DatabaseSync;

function insertGroup(id: string, extra: Record<string, unknown> = {}) {
	const columns = {
		id,
		group_did: `did:plc:group-${id}`,
		name: `Group ${id}`,
		created_at: 1,
		updated_at: 1,
		...extra
	};
	const keys = Object.keys(columns);
	db.prepare(
		`INSERT INTO groups (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
	).run(...(Object.values(columns) as never[]));
}

function addMembership(groupId: string, did: string, role: string) {
	db.prepare(
		`INSERT INTO memberships (id, group_id, did, role, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1, 1)`
	).run(`${groupId}-${did}`, groupId, did, role);
}

const count = (table: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();

beforeEach(() => {
	db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	applyGroupsSchemaSync(db);
});

afterEach(() => db.close());

describe('the migration itself', () => {
	it('splits into the statements wrangler runs as one script', () => {
		const fresh = new DatabaseSync(':memory:');
		try {
			fresh.exec(groupsSql);
			const tables = (
				fresh
					.prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name`)
					.all() as { name: string }[]
			).map((t) => t.name);
			expect(tables).toEqual(['groups', 'join_requests', 'memberships']);
		} finally {
			fresh.close();
		}
		expect(GROUPS_SCHEMA_STATEMENTS).toHaveLength(groupsSql.match(/^CREATE /gm)!.length);
	});

	it('re-applies cleanly', () => {
		expect(() => applyGroupsSchemaSync(db)).not.toThrow();
	});

	it('applies through ensureGroupsSchema on two cold isolates sharing one D1', async () => {
		const harness = sqliteD1(false);
		try {
			for (let isolate = 0; isolate < 2; isolate++) {
				vi.resetModules();
				const { ensureGroupsSchema } = await import('./schema');
				await expect(ensureGroupsSchema(harness.db)).resolves.toBeUndefined();
			}
		} finally {
			harness.close();
		}
	});

	it('retries a failed apply on the next call instead of caching the failure', async () => {
		const harness = sqliteD1(false);
		try {
			vi.resetModules();
			const { ensureGroupsSchema } = await import('./schema');
			const batch = vi
				.spyOn(harness.db, 'batch')
				.mockRejectedValueOnce(new Error('D1_ERROR: network connection lost'));

			await expect(ensureGroupsSchema(harness.db)).rejects.toThrow();
			await expect(ensureGroupsSchema(harness.db)).resolves.toBeUndefined();

			expect(batch).toHaveBeenCalledTimes(2);
			expect(
				harness.raw.prepare(`SELECT name FROM sqlite_schema WHERE name = 'groups'`).get()
			).toEqual({ name: 'groups' });
		} finally {
			harness.close();
		}
	});
});

describe('the roster rows', () => {
	beforeEach(() => insertGroup('g1'));

	it('keep any role id, as the records do', () => {
		expect(() => addMembership('g1', 'did:plc:alice', 'moderator')).not.toThrow();
		expect(() => addMembership('g1', 'did:plc:bob', 'admin')).not.toThrow();
	});

	it('go with their group', () => {
		addMembership('g1', 'did:plc:alice', 'member');
		db.prepare("DELETE FROM groups WHERE id = 'g1'").run();
		expect(count('memberships')).toEqual({ n: 0 });
	});

	it('keep one row per group DID', () => {
		expect(() => insertGroup('g2', { group_did: 'did:plc:group-g1' })).toThrow(/UNIQUE/);
	});
});

describe('one pending join request per (group, did)', () => {
	beforeEach(() => insertGroup('g1'));

	function request(id: string, did: string, status = 'pending') {
		db.prepare(
			`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
			 VALUES (?, 'g1', ?, ?, 1, 1)`
		).run(id, did, status);
	}

	it('refuses a second pending request from the same DID, and allows one once it is decided', () => {
		request('r1', 'did:plc:alice');
		expect(() => request('r2', 'did:plc:alice')).toThrow(/UNIQUE/);
		db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = 'r1'").run();
		expect(() => request('r2', 'did:plc:alice')).not.toThrow();
		expect(count('join_requests')).toEqual({ n: 2 });
	});

	it('does not constrain different DIDs, and refuses an unknown status', () => {
		request('r1', 'did:plc:alice');
		expect(() => request('r2', 'did:plc:bob')).not.toThrow();
		expect(() => request('r3', 'did:plc:carol', 'maybe')).toThrow(/CHECK/);
	});
});

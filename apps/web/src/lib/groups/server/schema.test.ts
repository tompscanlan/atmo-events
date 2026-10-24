// The SQL invariants, run against a real SQLite engine (D1 is SQLite). Each
// case is a rule the app relies on and would otherwise have to re-check in
// TypeScript at every call site, where the one code path that forgot would
// bypass it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyGroupsSchemaSync, GROUPS_SCHEMA_STATEMENTS } from './schema';
import groupsSql from '../../../../migrations/0001_groups.sql?raw';
import { sqliteD1 } from './__fixtures__/d1-sqlite';

let db: DatabaseSync;

function apply(target: DatabaseSync) {
	applyGroupsSchemaSync(target);
}

function insertGroup(id: string, ownerDid: string, extra: Record<string, unknown> = {}) {
	const columns = {
		id,
		group_did: `did:plc:group-${id}`,
		owner_did: ownerDid,
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

function roleId(groupId: string, name: string): string {
	const row = db
		.prepare('SELECT id FROM roles WHERE group_id = ? AND name = ?')
		.get(groupId, name) as { id: string } | undefined;
	if (!row) throw new Error(`no ${name} role in ${groupId}`);
	return row.id;
}

function seedRole(groupId: string, name: string) {
	db.prepare('INSERT INTO roles (id, group_id, name) VALUES (?, ?, ?)').run(
		`${groupId}-${name}`,
		groupId,
		name
	);
}

function addMembership(groupId: string, did: string, role: string) {
	db.prepare(
		`INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 1, 1)`
	).run(`${groupId}-${did}`, groupId, did, roleId(groupId, role));
}

beforeEach(() => {
	db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	apply(db);
});

afterEach(() => db.close());

describe('the migration itself', () => {
	it('splits into statements on the marker, not on semicolons', () => {
		// A `;`-based split would cut a trigger in half, which is why the marker
		// exists. Every trigger body must survive intact.
		const triggers = GROUPS_SCHEMA_STATEMENTS.filter((s) => s.includes('CREATE TRIGGER'));
		expect(triggers.length).toBeGreaterThanOrEqual(1);
		for (const trigger of triggers) {
			expect(trigger).toMatch(/BEGIN[\s\S]+END;$/);
		}
	});

	it('also runs as one script, the way wrangler runs a migration file', () => {
		const fresh = new DatabaseSync(':memory:');
		try {
			fresh.exec(groupsSql);
			const triggers = fresh
				.prepare(`SELECT name FROM sqlite_schema WHERE type = 'trigger'`)
				.all() as { name: string }[];
			expect(triggers.map((t) => t.name)).toEqual(['groups_identity_immutable']);
		} finally {
			fresh.close();
		}
	});

	it('re-applies cleanly (IF NOT EXISTS throughout)', () => {
		expect(() => apply(db)).not.toThrow();
	});

	it('applies through ensureGroupsSchema on two cold isolates sharing one D1', async () => {
		const harness = sqliteD1(false);
		try {
			for (let isolate = 0; isolate < 2; isolate++) {
				// A fresh module is a fresh isolate: `ensureGroupsSchema` memoizes
				// per module, so a second call on the same one would prove nothing.
				vi.resetModules();
				const { ensureGroupsSchema } = await import('./schema');
				await expect(ensureGroupsSchema(harness.db)).resolves.toBeUndefined();
			}
		} finally {
			harness.close();
		}
	});

	// A cached rejection would fail every request on the isolate until it was
	// recycled, all for one D1 blip at the first call.
	it('retries a failed apply on the next call instead of caching the failure', async () => {
		const harness = sqliteD1(false);
		try {
			vi.resetModules();
			const { ensureGroupsSchema } = await import('./schema');
			const batch = vi
				.spyOn(harness.db, 'batch')
				.mockRejectedValueOnce(new Error('D1_ERROR: network connection lost'));

			await expect(ensureGroupsSchema(harness.db)).rejects.toThrow('network connection lost');
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

describe('a role is admin or member', () => {
	beforeEach(() => insertGroup('g1', 'did:plc:creator'));

	it('refuses any other name, owner included, on insert and on update', () => {
		expect(() => seedRole('g1', 'moderator')).toThrow(/CHECK constraint failed/);
		expect(() => seedRole('g1', 'owner')).toThrow(/CHECK constraint failed/);
		seedRole('g1', 'member');
		expect(() =>
			db.prepare("UPDATE roles SET name = 'guest' WHERE group_id = ? AND name = 'member'").run('g1')
		).toThrow(/CHECK constraint failed/);
	});

	it('makes no role when a group is inserted', () => {
		expect(db.prepare('SELECT COUNT(*) AS n FROM roles WHERE group_id = ?').get('g1')).toEqual({
			n: 0
		});
	});
});

describe("a membership's role belongs to the same group", () => {
	it('refuses a role id borrowed from another group', () => {
		insertGroup('g1', 'did:plc:creator1');
		insertGroup('g2', 'did:plc:creator2');
		seedRole('g2', 'admin');
		const foreignRole = roleId('g2', 'admin');

		expect(() =>
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role_id, created_at, updated_at)
					 VALUES ('m', 'g1', 'did:plc:alice', ?, 1, 1)`
				)
				.run(foreignRole)
		).toThrow(/FOREIGN KEY/);
	});
});

describe('the creator is an ordinary admin', () => {
	beforeEach(() => {
		insertGroup('g1', 'did:plc:creator');
		seedRole('g1', 'admin');
		seedRole('g1', 'member');
		addMembership('g1', 'did:plc:creator', 'admin');
	});

	it('may be demoted, removed, or leave', () => {
		expect(() =>
			db
				.prepare('UPDATE memberships SET role_id = ? WHERE did = ?')
				.run(roleId('g1', 'member'), 'did:plc:creator')
		).not.toThrow();
		expect(() =>
			db.prepare('DELETE FROM memberships WHERE did = ?').run('did:plc:creator')
		).not.toThrow();
		expect(db.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 0 });
	});

	it('may hold any role from the start, and anyone may hold admin', () => {
		db.prepare('DELETE FROM memberships').run();
		expect(() => addMembership('g1', 'did:plc:creator', 'member')).not.toThrow();
		expect(() => addMembership('g1', 'did:plc:alice', 'admin')).not.toThrow();
	});

	// owner_did is the record of who created the group, and group_did is the group.
	it('refuses to rewrite owner_did or group_did', () => {
		expect(() =>
			db.prepare("UPDATE groups SET owner_did = 'did:plc:alice' WHERE id = 'g1'").run()
		).toThrow(/immutable/);
		expect(() =>
			db.prepare("UPDATE groups SET group_did = 'did:plc:other' WHERE id = 'g1'").run()
		).toThrow(/immutable/);
	});

	it('lets the whole group be deleted, cascading roster and roles', () => {
		addMembership('g1', 'did:plc:alice', 'member');
		expect(() => db.prepare("DELETE FROM groups WHERE id = 'g1'").run()).not.toThrow();
		expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 0 });
	});
});

describe('one row per group DID', () => {
	// The group's only uniqueness. There is no second name to reserve: the handle
	// registered at the host is the reservation, and it lives on a PDS, not in this
	// table.
	it('keeps group_did unique', () => {
		insertGroup('g1', 'did:plc:creator');
		expect(() => insertGroup('g2', 'did:plc:creator', { group_did: 'did:plc:group-g1' })).toThrow(
			/UNIQUE/
		);
	});
});

describe('one pending join request per (group, did)', () => {
	beforeEach(() => insertGroup('g1', 'did:plc:creator'));

	function request(id: string, did: string, status = 'pending') {
		db.prepare(
			`INSERT INTO join_requests (id, group_id, did, status, created_at, updated_at)
			 VALUES (?, 'g1', ?, ?, 1, 1)`
		).run(id, did, status);
	}

	it('refuses a second pending request from the same DID', () => {
		request('r1', 'did:plc:alice');
		expect(() => request('r2', 'did:plc:alice')).toThrow(/UNIQUE/);
	});

	it('allows a fresh request once the previous one is decided', () => {
		request('r1', 'did:plc:alice');
		db.prepare("UPDATE join_requests SET status = 'rejected' WHERE id = 'r1'").run();
		expect(() => request('r2', 'did:plc:alice')).not.toThrow();
		// The decided row survives as the audit trail.
		expect(db.prepare('SELECT COUNT(*) AS n FROM join_requests').get()).toEqual({ n: 2 });
	});

	it('does not constrain different DIDs or an unknown status', () => {
		request('r1', 'did:plc:alice');
		expect(() => request('r2', 'did:plc:bob')).not.toThrow();
		expect(() => request('r3', 'did:plc:carol', 'maybe')).toThrow();
	});
});

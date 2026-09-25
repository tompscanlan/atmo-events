// The SQL invariants, run against a real SQLite engine (D1 is SQLite). Each
// case is a rule the app relies on and would otherwise have to re-check in
// TypeScript at every call site, where the one code path that forgot would
// bypass it.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyGroupsSchemaSync, GROUPS_SCHEMA_STATEMENTS } from './schema';
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
	db.prepare('INSERT INTO roles (id, group_id, name, is_owner) VALUES (?, ?, ?, 0)').run(
		`${groupId}-${name}`,
		groupId,
		name
	);
}

function addMembership(groupId: string, did: string, role: string, status = 'active') {
	db.prepare(
		`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, 1, 1)`
	).run(`${groupId}-${did}`, groupId, did, roleId(groupId, role), status);
}

beforeEach(() => {
	db = new DatabaseSync(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	apply(db);
});

afterEach(() => db.close());

describe('the migration itself', () => {
	it('splits into statements on the marker, not on semicolons', () => {
		// A `;`-based split would cut the owner-protection triggers in half, which
		// is why the marker exists. Every trigger body must survive intact.
		const triggers = GROUPS_SCHEMA_STATEMENTS.filter((s) => s.includes('CREATE TRIGGER'));
		expect(triggers.length).toBeGreaterThanOrEqual(7);
		for (const trigger of triggers) {
			expect(trigger).toMatch(/BEGIN[\s\S]+END$/);
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
});

describe('a role is owner, admin or member', () => {
	beforeEach(() => insertGroup('g1', 'did:plc:owner'));

	it('accepts the two non-owner roles', () => {
		expect(() => {
			seedRole('g1', 'admin');
			seedRole('g1', 'member');
		}).not.toThrow();
	});

	it('refuses any other name, on insert and on update', () => {
		expect(() => seedRole('g1', 'moderator')).toThrow(/CHECK constraint failed/);
		seedRole('g1', 'member');
		expect(() =>
			db.prepare("UPDATE roles SET name = 'guest' WHERE group_id = ? AND name = 'member'").run('g1')
		).toThrow(/CHECK constraint failed/);
	});
});

describe('exactly one owner role per group', () => {
	it('creates the owner role as part of the group insert', () => {
		insertGroup('g1', 'did:plc:owner');
		const roles = db.prepare('SELECT name, is_owner FROM roles WHERE group_id = ?').all('g1');
		expect(roles).toEqual([{ name: 'owner', is_owner: 1 }]);
	});

	it('refuses a second owner role', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(() =>
			db
				.prepare("INSERT INTO roles (id, group_id, name, is_owner) VALUES ('x', 'g1', 'owner', 1)")
				.run()
		).toThrow();
	});

	it('refuses an is_owner flag that disagrees with the role name', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(() =>
			db
				.prepare("INSERT INTO roles (id, group_id, name, is_owner) VALUES ('x', 'g1', 'admin', 1)")
				.run()
		).toThrow();
		expect(() =>
			db
				.prepare("INSERT INTO roles (id, group_id, name, is_owner) VALUES ('y', 'g1', 'owner', 0)")
				.run()
		).toThrow();
	});

	it('refuses to delete, rename or demote the owner role', () => {
		insertGroup('g1', 'did:plc:owner');
		const id = roleId('g1', 'owner');
		expect(() => db.prepare('DELETE FROM roles WHERE id = ?').run(id)).toThrow(
			/owner role cannot be deleted/
		);
		expect(() => db.prepare("UPDATE roles SET name = 'admin' WHERE id = ?").run(id)).toThrow();
		expect(() => db.prepare('UPDATE roles SET is_owner = 0 WHERE id = ?').run(id)).toThrow();
	});
});

describe("a membership's role belongs to the same group", () => {
	it('refuses a role id borrowed from another group', () => {
		insertGroup('g1', 'did:plc:owner1');
		insertGroup('g2', 'did:plc:owner2');
		seedRole('g2', 'admin');
		const foreignRole = roleId('g2', 'admin');

		expect(() =>
			db
				.prepare(
					`INSERT INTO memberships (id, group_id, did, role_id, status, created_at, updated_at)
					 VALUES ('m', 'g1', 'did:plc:alice', ?, 'active', 1, 1)`
				)
				.run(foreignRole)
		).toThrow(/FOREIGN KEY/);
	});

	it('accepts a role id from its own group', () => {
		insertGroup('g1', 'did:plc:owner1');
		seedRole('g1', 'admin');
		expect(() => addMembership('g1', 'did:plc:alice', 'admin')).not.toThrow();
	});
});

describe('the owner cannot be demoted, removed or leave', () => {
	beforeEach(() => {
		insertGroup('g1', 'did:plc:owner');
		seedRole('g1', 'admin');
		seedRole('g1', 'member');
		addMembership('g1', 'did:plc:owner', 'owner');
	});

	it('refuses to demote the owner', () => {
		expect(() =>
			db
				.prepare('UPDATE memberships SET role_id = ? WHERE did = ?')
				.run(roleId('g1', 'admin'), 'did:plc:owner')
		).toThrow(/owner cannot be demoted/);
	});

	it('refuses to remove the owner, which is also how leaving is refused', () => {
		expect(() => db.prepare('DELETE FROM memberships WHERE did = ?').run('did:plc:owner')).toThrow(
			/owner cannot be removed and cannot leave/
		);
	});

	it('refuses to hand the owner role to anyone else, on insert or update', () => {
		expect(() => addMembership('g1', 'did:plc:alice', 'owner')).toThrow(/owner role is reserved/);
		addMembership('g1', 'did:plc:alice', 'member');
		expect(() =>
			db
				.prepare('UPDATE memberships SET role_id = ? WHERE did = ?')
				.run(roleId('g1', 'owner'), 'did:plc:alice')
		).toThrow(/owner role is reserved/);
	});

	it('refuses an owner membership that is not the owner role', () => {
		db.prepare('DELETE FROM groups WHERE id = ?').run('g1');
		insertGroup('g2', 'did:plc:owner');
		seedRole('g2', 'member');
		expect(() => addMembership('g2', 'did:plc:owner', 'member')).toThrow(
			/owner must hold an active owner membership|owner role is reserved/
		);
	});

	// The protection is anchored on groups.owner_did, so if that column were
	// writable every trigger above could be sidestepped with one UPDATE.
	it('refuses to rewrite owner_did or group_did', () => {
		expect(() =>
			db.prepare("UPDATE groups SET owner_did = 'did:plc:alice' WHERE id = 'g1'").run()
		).toThrow(/immutable/);
		expect(() =>
			db.prepare("UPDATE groups SET group_did = 'did:plc:other' WHERE id = 'g1'").run()
		).toThrow(/immutable/);
	});

	// The owner triggers must not turn a group into something undeletable.
	it('still lets the whole group be deleted, cascading roster and roles', () => {
		addMembership('g1', 'did:plc:alice', 'member');
		expect(() => db.prepare("DELETE FROM groups WHERE id = 'g1'").run()).not.toThrow();
		expect(db.prepare('SELECT COUNT(*) AS n FROM roles').get()).toEqual({ n: 0 });
		expect(db.prepare('SELECT COUNT(*) AS n FROM memberships').get()).toEqual({ n: 0 });
	});
});

describe('a membership is active or absent', () => {
	beforeEach(() => {
		insertGroup('g1', 'did:plc:owner');
		seedRole('g1', 'member');
		addMembership('g1', 'did:plc:member', 'member');
	});

	it('refuses a suspended status, on insert and on update', () => {
		expect(() => addMembership('g1', 'did:plc:new', 'member', 'suspended')).toThrow(
			/CHECK constraint failed/
		);
		expect(() =>
			db.prepare("UPDATE memberships SET status = 'suspended' WHERE did = ?").run('did:plc:member')
		).toThrow(/CHECK constraint failed/);
	});
});

describe('a private group requires approval to join', () => {
	it('refuses a private open-join group on insert', () => {
		expect(() =>
			insertGroup('g1', 'did:plc:owner', { visibility: 'private', require_approval: 0 })
		).toThrow(/private group must require approval/);
	});

	it('refuses making a group private and open-join by update, either way round', () => {
		insertGroup('g1', 'did:plc:owner', { require_approval: 0 });
		expect(() =>
			db.prepare("UPDATE groups SET visibility = 'private' WHERE id = ?").run('g1')
		).toThrow(/private group must require approval/);
		insertGroup('g2', 'did:plc:owner', { visibility: 'private' });
		expect(() =>
			db.prepare('UPDATE groups SET require_approval = 0 WHERE id = ?').run('g2')
		).toThrow(/private group must require approval/);
	});
});

describe('group row defaults and domains', () => {
	it('defaults require_approval to 1', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(db.prepare('SELECT require_approval FROM groups WHERE id = ?').get('g1')).toEqual({
			require_approval: 1
		});
	});

	it('defaults visibility to public and both space URIs to unprovisioned', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(
			db
				.prepare('SELECT visibility, about_space_uri, members_space_uri FROM groups WHERE id = ?')
				.get('g1')
		).toEqual({
			visibility: 'public',
			// NULL, not a default type: a group's spaces exist once the PDS has
			// confirmed them, and the row must be able to say "not yet".
			about_space_uri: null,
			members_space_uri: null
		});
	});

	it('refuses an unknown visibility', () => {
		expect(() => insertGroup('g1', 'did:plc:owner', { visibility: 'secret' })).toThrow();
	});

	// The group's only uniqueness. There is no second name to reserve: the handle
	// registered at mint is the reservation, and it lives on a PDS, not in this
	// table.
	it('keeps group_did unique', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(() => insertGroup('g2', 'did:plc:owner', { group_did: 'did:plc:group-g1' })).toThrow(
			/UNIQUE/
		);
	});
});

describe('one pending join request per (group, did)', () => {
	beforeEach(() => insertGroup('g1', 'did:plc:owner'));

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

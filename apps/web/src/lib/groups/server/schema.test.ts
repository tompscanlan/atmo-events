// The SQL invariants, exercised against a real SQLite engine (D1 is SQLite).
// Every case here is a rule the app relies on and would otherwise have to
// re-check in TypeScript at every call site — the kind of rule that gets
// bypassed by the one code path that forgot.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { GROUPS_MIGRATION_STATEMENTS, GROUPS_SCHEMA_STATEMENTS } from './schema';

let db: DatabaseSync;

function apply(target: DatabaseSync) {
	for (const statement of GROUPS_SCHEMA_STATEMENTS) target.exec(statement);
}

function insertGroup(id: string, ownerDid: string, extra: Record<string, unknown> = {}) {
	const columns = {
		id,
		group_did: `did:plc:group-${id}`,
		owner_did: ownerDid,
		name: `Group ${id}`,
		slug: id,
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

	it('re-applies cleanly (every object is IF NOT EXISTS)', () => {
		expect(() => apply(db)).not.toThrow();
	});
});

// 0004 is a DATA migration, and the only database it can be wrong about is one
// that already holds five roles — which every group created before 2026-09-19
// does, including the live one on the alpha. Applying it to an empty database
// (what every other case here does) exercises none of it.
describe('migration 0004: reconciling a five-role group', () => {
	const LEGACY = GROUPS_MIGRATION_STATEMENTS.slice(0, 3).flat();
	const RECONCILE = GROUPS_MIGRATION_STATEMENTS[3];
	// What the 09-08 seeder actually wrote for a manager role.
	const LEGACY_ADMIN_BUNDLE = [
		'MANAGE_GROUP',
		'MANAGE_MEMBERS',
		'MANAGE_EVENTS',
		'CREATE_EVENT',
		'MANAGE_BILLING',
		'SEE_GROUP',
		'SEE_EVENTS',
		'SEE_MEMBERS'
	];

	function grant(groupId: string, role: string, permissions: readonly string[]) {
		for (const permission of permissions) {
			db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)').run(
				roleId(groupId, role),
				permission
			);
		}
	}

	function names(groupId: string, role: string): string[] {
		return db
			.prepare(
				`SELECT rp.permission FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
				 WHERE r.group_id = ? AND r.name = ? ORDER BY rp.permission`
			)
			.all(groupId, role)
			.map((row) => (row as { permission: string }).permission);
	}

	function reconcile() {
		for (const statement of RECONCILE) db.exec(statement);
	}

	beforeEach(() => {
		db.close();
		db = new DatabaseSync(':memory:');
		db.exec('PRAGMA foreign_keys = ON');
		for (const statement of LEGACY) db.exec(statement);

		insertGroup('g1', 'did:plc:owner');
		for (const role of ['admin', 'moderator', 'member', 'guest']) seedRole('g1', role);
		grant('g1', 'owner', [...LEGACY_ADMIN_BUNDLE, 'DELETE_GROUP']);
		grant('g1', 'admin', LEGACY_ADMIN_BUNDLE);
		grant('g1', 'moderator', ['MANAGE_DISCUSSIONS', 'SEE_MEMBERS']);
		grant('g1', 'guest', ['CONTACT_ADMINS']);
		addMembership('g1', 'did:plc:mod', 'moderator');
		addMembership('g1', 'did:plc:applicant', 'guest');
		addMembership('g1', 'did:plc:member', 'member');
	});

	it('keeps a manager managing: MANAGE_MEMBERS becomes the three grants that replaced it', () => {
		// The failure this exists to catch is silent: delete the legacy name
		// without writing the replacements and every deployed group keeps its
		// admins and loses their ability to admit, eject or promote anyone.
		reconcile();
		expect(names('g1', 'admin')).toEqual([
			'ADMIT_MEMBERS',
			'ASSIGN_ROLES',
			'CREATE_EVENT',
			'EJECT_MEMBERS',
			'MANAGE_EVENTS',
			'MANAGE_GROUP'
		]);
		// And nothing outside the pared vocabulary survives anywhere.
		expect(names('g1', 'owner')).toEqual(names('g1', 'admin'));
		expect(names('g1', 'member')).toEqual([]);
	});

	it('maps a moderator to member and a guest off the roster entirely', () => {
		reconcile();
		const roster = db
			.prepare(
				`SELECT m.did, r.name AS role FROM memberships m JOIN roles r ON r.id = m.role_id
				 WHERE m.group_id = ? ORDER BY m.did`
			)
			.all('g1');
		expect(roster).toEqual([
			{ did: 'did:plc:member', role: 'member' },
			{ did: 'did:plc:mod', role: 'member' }
		]);
		expect(db.prepare('SELECT name FROM roles WHERE group_id = ? ORDER BY name').all('g1')).toEqual(
			[{ name: 'admin' }, { name: 'member' }, { name: 'owner' }]
		);
	});

	it('refuses a dropped role name afterwards, and re-applies cleanly', () => {
		reconcile();
		expect(() => seedRole('g1', 'moderator')).toThrow(/owner, admin or member/);
		expect(() =>
			db.prepare("UPDATE roles SET name = 'guest' WHERE group_id = ? AND name = 'member'").run('g1')
		).toThrow(/owner, admin or member/);
		// The runner replays every statement on each cold isolate.
		expect(() => reconcile()).not.toThrow();
		expect(names('g1', 'admin')).toHaveLength(6);
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

describe('the owner cannot be demoted, suspended, removed or leave', () => {
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

	it('refuses to suspend the owner', () => {
		expect(() =>
			db.prepare("UPDATE memberships SET status = 'suspended' WHERE did = ?").run('did:plc:owner')
		).toThrow(/owner cannot be demoted|owner cannot be/);
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

	it('refuses an owner membership that is not active or not the owner role', () => {
		db.prepare('DELETE FROM groups WHERE id = ?').run('g1');
		insertGroup('g2', 'did:plc:owner');
		seedRole('g2', 'member');
		expect(() => addMembership('g2', 'did:plc:owner', 'member')).toThrow(
			/owner must hold an active owner membership|owner role is reserved/
		);
		expect(() => addMembership('g2', 'did:plc:owner', 'owner', 'suspended')).toThrow(
			/owner must hold an active owner membership/
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

describe('group row defaults and domains', () => {
	it('defaults require_approval to 1', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(db.prepare('SELECT require_approval FROM groups WHERE id = ?').get('g1')).toEqual({
			require_approval: 1
		});
	});

	it('defaults status to draft, visibility to public, and both space URIs to unprovisioned', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(
			db
				.prepare(
					'SELECT status, visibility, about_space_uri, members_space_uri FROM groups WHERE id = ?'
				)
				.get('g1')
		).toEqual({
			status: 'draft',
			visibility: 'public',
			// NULL, not a default type: a group's spaces exist once the PDS has
			// confirmed them, and the row must be able to say "not yet".
			about_space_uri: null,
			members_space_uri: null
		});
	});

	it('refuses an unknown status or visibility', () => {
		expect(() => insertGroup('g1', 'did:plc:owner', { status: 'archived' })).toThrow();
		expect(() => insertGroup('g2', 'did:plc:owner', { visibility: 'secret' })).toThrow();
	});

	it('keeps slug and group_did unique', () => {
		insertGroup('g1', 'did:plc:owner');
		expect(() => insertGroup('g2', 'did:plc:owner', { slug: 'g1' })).toThrow(/UNIQUE/);
		expect(() => insertGroup('g3', 'did:plc:owner', { group_did: 'did:plc:group-g1' })).toThrow(
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

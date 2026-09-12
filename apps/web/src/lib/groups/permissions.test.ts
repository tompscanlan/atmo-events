import { describe, it, expect } from 'vitest';
import {
	ASSIGNABLE_ROLES,
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_PERMISSIONS,
	V1_ENFORCED_PERMISSIONS,
	V1_INERT_PERMISSIONS,
	can,
	isGroupPermission,
	resolvePermissions,
	type GroupPermission
} from './permissions';

describe('the legacy role bundles', () => {
	// The counts are the contract with the legacy seeder
	// (openmeet-api/src/database/seeds/relational/group-role/group-role.service.ts):
	// a bundle that quietly gained or lost a permission during the port would
	// change a role's power without anyone deciding to.
	it('carries the legacy sizes: owner 16, admin 14, moderator 7, member 7, guest 1', () => {
		expect(DEFAULT_ROLE_PERMISSIONS.owner).toHaveLength(16);
		expect(DEFAULT_ROLE_PERMISSIONS.admin).toHaveLength(14);
		expect(DEFAULT_ROLE_PERMISSIONS.moderator).toHaveLength(7);
		expect(DEFAULT_ROLE_PERMISSIONS.member).toHaveLength(7);
		expect(DEFAULT_ROLE_PERMISSIONS.guest).toHaveLength(1);
	});

	it('names only permissions that exist, with no duplicates', () => {
		for (const [role, bundle] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
			expect(new Set(bundle).size, `${role} has a duplicate`).toBe(bundle.length);
			for (const permission of bundle) {
				expect(isGroupPermission(permission), `${role}: ${permission}`).toBe(true);
			}
		}
	});

	it('keeps the legacy gaps rather than tidying them up', () => {
		// Legacy's owner bundle omits MESSAGE_MEMBER and its admin bundle omits
		// DELETE_GROUP. Both look like oversights and both are deliberately copied,
		// so parity with an existing tenant is checkable.
		expect(DEFAULT_ROLE_PERMISSIONS.owner).not.toContain('MESSAGE_MEMBER');
		expect(DEFAULT_ROLE_PERMISSIONS.admin).not.toContain('DELETE_GROUP');
	});

	it('never offers the owner role for assignment', () => {
		expect(ASSIGNABLE_ROLES).toEqual(['admin', 'moderator', 'member', 'guest']);
	});
});

describe('the v1 enforced / inert split', () => {
	it('leaves exactly ten permissions stored but inert', () => {
		expect(GROUP_PERMISSIONS).toHaveLength(17);
		expect(V1_ENFORCED_PERMISSIONS).toHaveLength(7);
		expect(V1_INERT_PERMISSIONS).toHaveLength(10);
		expect([...V1_ENFORCED_PERMISSIONS, ...V1_INERT_PERMISSIONS].sort()).toEqual(
			[...GROUP_PERMISSIONS].sort()
		);
	});

	// The whole point of the split: the OWNER bundle contains MANAGE_BILLING,
	// MANAGE_REPORTS, MANAGE_DISCUSSIONS and the rest, and a v1 handler must not
	// grant on any of them — no behaviour exists behind those names yet.
	it('refuses every inert permission even for a role that holds it', () => {
		const owner = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.owner]);
		for (const permission of V1_INERT_PERMISSIONS) {
			if (!DEFAULT_ROLE_PERMISSIONS.owner.includes(permission)) continue;
			expect(owner.has(permission), `owner stores ${permission}`).toBe(true);
			expect(can(owner, permission), `can() must refuse ${permission}`).toBe(false);
		}
	});

	it('grants an enforced permission only when the role holds it', () => {
		const admin = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.admin]);
		const member = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.member]);

		expect(can(admin, 'MANAGE_EVENTS')).toBe(true);
		expect(can(admin, 'CREATE_EVENT')).toBe(true);
		expect(can(admin, 'MANAGE_MEMBERS')).toBe(true);
		expect(can(admin, 'MANAGE_GROUP')).toBe(true);

		// A member sees the group but cannot run it — the distinction the events
		// page and the members page both hang on.
		expect(can(member, 'SEE_EVENTS')).toBe(true);
		expect(can(member, 'SEE_MEMBERS')).toBe(true);
		expect(can(member, 'CREATE_EVENT')).toBe(false);
		expect(can(member, 'MANAGE_EVENTS')).toBe(false);
		expect(can(member, 'MANAGE_MEMBERS')).toBe(false);
	});

	it('gives a guest nothing v1 acts on', () => {
		const guest = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.guest]);
		for (const permission of V1_ENFORCED_PERMISSIONS) {
			expect(can(guest, permission), permission).toBe(false);
		}
	});

	it('gives an off-roster caller nothing', () => {
		const none = resolvePermissions([]);
		for (const permission of GROUP_PERMISSIONS) {
			expect(can(none, permission), permission).toBe(false);
		}
	});
});

describe('resolvePermissions', () => {
	it('unions the grants it is given, with no deny rules', () => {
		const resolved = resolvePermissions([
			['SEE_GROUP', 'SEE_EVENTS'],
			['SEE_EVENTS', 'CREATE_EVENT']
		]);
		expect([...resolved].sort()).toEqual(['CREATE_EVENT', 'SEE_EVENTS', 'SEE_GROUP']);
	});

	// role_permissions is written by a seeder that may be older than the build
	// reading it, so an unrecognised row must be dropped, not trusted.
	it('drops rows outside the vocabulary', () => {
		const resolved = resolvePermissions([['SEE_GROUP', 'MANAGE_EVERYTHING', '']]);
		expect([...resolved]).toEqual(['SEE_GROUP']);
		expect(can(resolved, 'MANAGE_EVERYTHING' as GroupPermission)).toBe(false);
	});
});

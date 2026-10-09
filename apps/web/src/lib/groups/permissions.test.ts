import { describe, it, expect } from 'vitest';
import {
	ASSIGNABLE_BY_ROLE,
	COMMUNITY_PERMISSIONS,
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_PERMISSIONS,
	GROUP_ROLES,
	PUBLISHED_ACTION,
	can,
	resolvePermissions,
	type GroupPermission
} from './permissions';

describe('the published bridge', () => {
	// The record is the interop surface and the enum is not, so every name must
	// have exactly one published form, and the community four must carry the
	// standard's own identifiers rather than our spellings.
	it('publishes the standard identifier for every community action', () => {
		expect(Object.fromEntries(COMMUNITY_PERMISSIONS.map((p) => [p, PUBLISHED_ACTION[p]]))).toEqual({
			MANAGE_GROUP: 'group.configure',
			ADMIT_MEMBERS: 'admit',
			EJECT_MEMBERS: 'eject',
			ASSIGN_ROLES: 'role.assign'
		});
	});

	it('maps every name in the vocabulary, with no two sharing a published form', () => {
		const published = GROUP_PERMISSIONS.map((p) => PUBLISHED_ACTION[p]);
		expect(published.filter(Boolean)).toHaveLength(GROUP_PERMISSIONS.length);
		expect(new Set(published).size).toBe(GROUP_PERMISSIONS.length);
	});
});

describe('the seeded role bundles', () => {
	// Published as each binding's `assignable`, which bounds both role.assign and
	// eject. The owner is protected by being on no other role's list.
	it('lets no role but the owner assign or eject the owner', () => {
		expect(ASSIGNABLE_BY_ROLE.owner).toContain('owner');
		for (const role of GROUP_ROLES) {
			if (role !== 'owner') expect(ASSIGNABLE_BY_ROLE[role], role).not.toContain('owner');
		}
	});

	it('gives a member no permission at all, since membership is what a member holds', () => {
		const member = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.member]);
		for (const permission of GROUP_PERMISSIONS) {
			expect(can(member, permission), permission).toBe(false);
		}
	});
});

describe('resolvePermissions', () => {
	// role_permissions may be written by a seeder older than the build reading
	// it, so a row can name a permission this build does not define. Such a row
	// must grant nothing.
	it('drops stale and unknown rows rather than trusting them', () => {
		const resolved = resolvePermissions([
			['MANAGE_GROUP', 'MANAGE_MEMBERS', 'SEE_MEMBERS', 'MANAGE_EVERYTHING', '']
		]);
		expect([...resolved]).toEqual(['MANAGE_GROUP']);
		expect(can(resolved, 'MANAGE_MEMBERS' as GroupPermission)).toBe(false);
	});
});

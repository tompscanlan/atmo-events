import { describe, it, expect } from 'vitest';
import {
	ASSIGNABLE_BY_ROLE,
	COMMUNITY_PERMISSIONS,
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_PERMISSIONS,
	GROUP_ROLES,
	MODALITY_PERMISSIONS,
	PUBLISHED_ACTION,
	PUBLISHED_SCOPES,
	can,
	resolvePermissions,
	type GroupPermission
} from './permissions';

describe('the published bridge', () => {
	// The record is the interop surface and the enum is not, so the community four
	// must publish the scopes the standard's own records grant, not our spellings.
	it('publishes the standard scopes for every community permission', () => {
		const membership = 'space:group.opensocial.members?collection=group.opensocial.membership';
		expect(PUBLISHED_SCOPES).toEqual({
			MANAGE_GROUP: [
				'include:group.opensocial.configure',
				'include:group.opensocial.manageSpaces',
				'space:*?collection=group.opensocial.access'
			],
			ADMIT_MEMBERS: [`${membership}&action=create`],
			EJECT_MEMBERS: [`${membership}&action=delete`],
			ASSIGN_ROLES: [`${membership}&action=update`]
		});
	});

	it('gives each community permission scopes no other one shares', () => {
		const all = COMMUNITY_PERMISSIONS.flatMap((p) => PUBLISHED_SCOPES[p]);
		expect(new Set(all).size).toBe(all.length);
	});

	it('maps each event permission to an action of its own', () => {
		const published = MODALITY_PERMISSIONS.map((p) => PUBLISHED_ACTION[p]);
		expect(published.filter(Boolean)).toHaveLength(MODALITY_PERMISSIONS.length);
		expect(new Set(published).size).toBe(MODALITY_PERMISSIONS.length);
	});
});

describe('the seeded role bundles', () => {
	// Published as each binding's `assignable`, which bounds both role.assign and
	// eject. There is no owner (TS, 2026-10-20): an admin may assign and eject any
	// admin, the creator included, as at the group host.
	it('has only the host’s two roles, and lets an admin assign and eject either', () => {
		expect(GROUP_ROLES).toEqual(['admin', 'member']);
		expect(ASSIGNABLE_BY_ROLE.admin).toEqual(['admin', 'member']);
		expect(ASSIGNABLE_BY_ROLE.member).toEqual([]);
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

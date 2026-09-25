import { describe, it, expect } from 'vitest';
import {
	ASSIGNABLE_ROLES,
	COMMUNITY_PERMISSIONS,
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_PERMISSIONS,
	GROUP_ROLES,
	MODALITY_PERMISSIONS,
	PUBLISHED_ACTION,
	can,
	isEnforced,
	isGroupPermission,
	resolvePermissions,
	type GroupPermission
} from './permissions';

describe('the permission vocabulary', () => {
	// The vocabulary is the enforced set. A name nothing enforces is a grant that
	// does nothing, and once the lexicon is published it is a name a peer app
	// reads and honors.
	it('enforces every name it defines, leaving nothing inert', () => {
		expect(GROUP_PERMISSIONS.filter((p) => !isEnforced(p))).toEqual([]);
	});

	it('splits into four community actions and two modality actions, with no read gate', () => {
		expect([...COMMUNITY_PERMISSIONS, ...MODALITY_PERMISSIONS]).toEqual([...GROUP_PERMISSIONS]);
		expect(COMMUNITY_PERMISSIONS).toHaveLength(4);
		expect(MODALITY_PERMISSIONS).toHaveLength(2);
		// Read access is the access record plus the space read policy the host
		// enforces, never a permission a group can withhold.
		expect(GROUP_PERMISSIONS.filter((p) => p.startsWith('SEE_'))).toEqual([]);
	});

	// Separate grants, because one combined grant would make admitting a member
	// the same privilege as promoting one, and a promotion can reach `admin`.
	it('grants admitting, ejecting and role assignment independently', () => {
		expect(isGroupPermission('MANAGE_MEMBERS')).toBe(false);
		for (const name of ['ADMIT_MEMBERS', 'EJECT_MEMBERS', 'ASSIGN_ROLES']) {
			expect(isGroupPermission(name), name).toBe(true);
		}
	});
});

describe('the published bridge', () => {
	// The record is the interop surface and the enum is not, so every name must
	// have exactly one published form, and the community four must carry the
	// standard's own identifiers rather than our spellings.
	it('publishes the standard identifier for every community action', () => {
		expect(Object.fromEntries(COMMUNITY_PERMISSIONS.map((p) => [p, PUBLISHED_ACTION[p]]))).toEqual({
			MANAGE_GROUP: 'community.configure',
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
	it('seeds three roles and offers two of them for assignment', () => {
		// `owner` is pinned to groups.owner_did by SQL trigger, so offering it
		// would only produce a constraint error.
		expect([...GROUP_ROLES]).toEqual(['owner', 'admin', 'member']);
		expect(ASSIGNABLE_ROLES).toEqual(['admin', 'member']);
	});

	it('names only permissions that exist, with no duplicates', () => {
		for (const [role, bundle] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
			expect(new Set(bundle).size, `${role} has a duplicate`).toBe(bundle.length);
			for (const permission of bundle) {
				expect(isGroupPermission(permission), `${role}: ${permission}`).toBe(true);
			}
		}
	});

	it('gives a member no permission at all — membership is what a member holds', () => {
		const member = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.member]);
		for (const permission of GROUP_PERMISSIONS) {
			expect(can(member, permission), permission).toBe(false);
		}
	});

	it('gives an admin every name, and an off-roster caller none', () => {
		const admin = resolvePermissions([DEFAULT_ROLE_PERMISSIONS.admin]);
		const stranger = resolvePermissions([]);
		for (const permission of GROUP_PERMISSIONS) {
			expect(can(admin, permission), `admin: ${permission}`).toBe(true);
			expect(can(stranger, permission), `stranger: ${permission}`).toBe(false);
		}
	});
});

describe('resolvePermissions', () => {
	it('unions the grants it is given, with no deny rules', () => {
		const resolved = resolvePermissions([
			['MANAGE_GROUP', 'CREATE_EVENT'],
			['CREATE_EVENT', 'ADMIT_MEMBERS']
		]);
		expect([...resolved].sort()).toEqual(['ADMIT_MEMBERS', 'CREATE_EVENT', 'MANAGE_GROUP']);
	});

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

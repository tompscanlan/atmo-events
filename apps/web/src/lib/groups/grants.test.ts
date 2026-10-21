import { describe, it, expect } from 'vitest';
import example from './__fixtures__/opensocial-example-records.json';
import { communityPermissions, memberGrants } from './grants';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	groupBindingsRecord,
	parseGroupAccess,
	parseGroupGrants
} from './members-record';
import {
	COMMUNITY_PERMISSIONS,
	DEFAULT_ROLE_PERMISSIONS,
	GROUP_ROLES,
	type GroupPermission
} from './permissions';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

const GROUP = 'did:plc:group';

describe("atmo's own grants", () => {
	// What atmo publishes for a bundle must read back as that bundle, through the
	// same scope checks the gate makes, or a role would lose or gain powers by
	// being written down.
	it('read back as the community names of every default bundle', () => {
		const permissions = parseGroupGrants(
			groupBindingsRecord({ altitude: 'community', bundles: DEFAULT_ROLE_PERMISSIONS })
		);
		for (const role of GROUP_ROLES) {
			const community = DEFAULT_ROLE_PERMISSIONS[role].filter((p) =>
				(COMMUNITY_PERMISSIONS as readonly GroupPermission[]).includes(p)
			);
			expect(
				communityPermissions(memberGrants({ roles: [role], permissions }), GROUP),
				role
			).toEqual(community);
		}
	});

	it('read back as exactly one name, for a bundle of one', () => {
		for (const permission of COMMUNITY_PERMISSIONS) {
			const permissions = parseGroupGrants(
				groupBindingsRecord({ altitude: 'community', bundles: { admin: [permission] } })
			);
			expect(
				communityPermissions(memberGrants({ roles: ['admin'], permissions }), GROUP),
				permission
			).toEqual([permission]);
		}
	});

	it('union a role granted twice', () => {
		const permissions = parseGroupGrants({
			grants: [
				...(groupBindingsRecord({ altitude: 'community', bundles: { admin: ['ADMIT_MEMBERS'] } })
					.grants as unknown[]),
				...(groupBindingsRecord({ altitude: 'community', bundles: { admin: ['EJECT_MEMBERS'] } })
					.grants as unknown[])
			]
		});
		expect(communityPermissions(memberGrants({ roles: ['admin'], permissions }), GROUP)).toEqual([
			'ADMIT_MEMBERS',
			'EJECT_MEMBERS'
		]);
	});

	// A scope to write memberships with no role to hand out admits nobody.
	it('need a role to assign before a roster act reads as allowed', () => {
		const scopes = ['include:group.opensocial.manageMembers'];
		const without = memberGrants({ roles: ['helper'], permissions: [{ role: 'helper', scopes }] });
		expect(communityPermissions(without, GROUP)).toEqual([]);
		const withRole = memberGrants({
			roles: ['helper'],
			permissions: [{ role: 'helper', scopes, assignable: ['member'] }]
		});
		expect(communityPermissions(withRole, GROUP)).toEqual([
			'ADMIT_MEMBERS',
			'EJECT_MEMBERS',
			'ASSIGN_ROLES'
		]);
	});
});

// SC-207: upstream's own example group (`examples/records.json` at the pinned
// commit), read through atmo's parsers and checked by atmo's gate, gives the
// answers of the primer's worked checks. (Spec: FR-213.)
describe("upstream's example group", () => {
	const records = example as { uri: string; value: Record<string, unknown> }[];
	const garden = records[0].uri.split('/')[2];
	const find = (collection: string, spaceType: string) =>
		records.find(
			(record) => record.value.$type === collection && record.uri.includes(`/space/${spaceType}/`)
		)!.value;
	const permissions = parseGroupGrants(find(GROUP_PERMISSIONS_COLLECTION, MEMBERS_SPACE_TYPE));
	const membersAccess = parseGroupAccess(find(GROUP_ACCESS_COLLECTION, MEMBERS_SPACE_TYPE));
	const aboutAccess = parseGroupAccess(find(GROUP_ACCESS_COLLECTION, ABOUT_SPACE_TYPE));
	const grantsOf = (role: string) =>
		memberGrants({ roles: [role], permissions, membersAccess, aboutAccess });
	const names = (role: string) => communityPermissions(grantsOf(role), garden);

	it('is the group the primer reads', () => {
		expect(permissions?.map((grant) => grant.role)).toEqual(['admin', 'moderator']);
		expect(membersAccess?.grants.map((grant) => grant.role)).toEqual(['member', 'moderator']);
	});

	it('gives a member no roster act', () => {
		expect(names('member')).toEqual([]);
	});

	it("lets an admin eject, a moderator's holder included", () => {
		expect(names('admin')).toContain('EJECT_MEMBERS');
		expect(grantsOf('admin').assignable.has('moderator')).toBe(true);
	});

	// `assignable` names member, but no scope of the moderator's reaches
	// `membership`, and both are needed.
	it("gives a moderator no roster act on a member's membership", () => {
		expect(grantsOf('moderator').assignable.has('member')).toBe(true);
		expect(names('moderator')).not.toContain('EJECT_MEMBERS');
	});

	// Before this check, a grant of `include:` read as no permission at all.
	it("reads the admin's permission sets as everything atmo asks", () => {
		expect(communityPermissions(grantsOf('admin'), garden)).toEqual([...COMMUNITY_PERMISSIONS]);
		expect(communityPermissions(grantsOf('moderator'), garden)).toEqual([]);
	});
});

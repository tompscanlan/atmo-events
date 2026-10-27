import { describe, it, expect } from 'vitest';
import example from './__fixtures__/opensocial-example-records.json';
import { HOST_PERMISSIONS } from './server/__fixtures__/host-records';
import { grantsAnyWrite, memberGrants, permissionsFor } from './grants';
import {
	GROUP_ACCESS_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	parseGroupAccess,
	parseGroupGrants
} from './members-record';
import { COMMUNITY_PERMISSIONS, GROUP_PERMISSIONS } from './permissions';
import { ABOUT_SPACE_TYPE, MEMBERS_SPACE_TYPE } from './types';

const GROUP = 'did:plc:group';
const names = (grants: ReturnType<typeof memberGrants>, groupDid = GROUP) => [
	...permissionsFor(grants, groupDid)
];

describe("the group host's own permissions record", () => {
	const permissions = parseGroupGrants(HOST_PERMISSIONS);

	it('gives an admin every permission atmo asks, and a member none', () => {
		expect(names(memberGrants({ roles: ['admin'], permissions }))).toEqual([...GROUP_PERMISSIONS]);
		expect(names(memberGrants({ roles: ['member'], permissions }))).toEqual([]);
	});

	it('lets an admin hold a group session, and not a member', () => {
		expect(grantsAnyWrite(memberGrants({ roles: ['admin'], permissions }))).toBe(true);
		expect(grantsAnyWrite(memberGrants({ roles: ['member'], permissions }))).toBe(false);
	});
});

describe('roster acts', () => {
	it('need a role to assign as well as a scope on memberships', () => {
		const scopes = ['include:group.opensocial.manageMembers'];
		const without = memberGrants({ roles: ['helper'], permissions: [{ role: 'helper', scopes }] });
		expect(names(without)).toEqual([]);
		const withRole = memberGrants({
			roles: ['helper'],
			permissions: [{ role: 'helper', scopes, assignable: ['member'] }]
		});
		expect(names(withRole)).toEqual(['ADMIT_MEMBERS', 'EJECT_MEMBERS', 'ASSIGN_ROLES']);
	});

	it('read a read-only grant as no write', () => {
		const read = memberGrants({
			roles: ['member'],
			permissions: [{ role: 'member', scopes: ['space:*?action=read'] }]
		});
		expect(grantsAnyWrite(read)).toBe(false);
	});
});

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

	it("reads the admin's permission sets as every community permission", () => {
		expect(names(grantsOf('admin'), garden)).toEqual([...COMMUNITY_PERMISSIONS]);
	});

	it('gives a member and a moderator no roster act', () => {
		expect(names(grantsOf('member'), garden)).toEqual([]);
		expect(grantsOf('moderator').assignable.has('member')).toBe(true);
		expect(names(grantsOf('moderator'), garden)).toEqual([]);
	});
});

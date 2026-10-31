// The members space as the group host seeds it (spike/host.mjs `seedRecords`): the two
// role records, the `permissions` record, the space's `access`, and a membership per member.
import { MEMBERS_SPACE_TYPE, SPACE_SKEY, spaceUri } from '../../ids';
import { GROUP_ROLES, type GroupRoleName } from '../../permissions';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupAccessRecord,
	groupMembershipRecord
} from '../../members-record';

export interface HostRecord {
	space: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
}

/** The host's `permissions` record at create. */
export const HOST_PERMISSIONS = {
	grants: [
		{
			role: 'admin',
			scopes: [
				'include:group.opensocial.configure',
				'include:group.opensocial.manageSpaces',
				'include:group.opensocial.manageMembers',
				'include:group.opensocial.moderate',
				'space:*?action=read_self&manage=create&manage=delete',
				'space:*?collection=*',
				'repo:*',
				'blob:*/*'
			],
			assignable: ['admin', 'member']
		},
		{ role: 'member', scopes: [], assignable: [] }
	]
};

/** Each record names its space, so a host holding other spaces can hold these too. */
export function authzRecords(
	groupDid: string,
	roster: Record<string, GroupRoleName>
): HostRecord[] {
	const space = spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY);
	const record = (collection: string, rkey: string, value: object) => ({
		space,
		collection,
		rkey,
		value: { ...value, $type: collection }
	});
	const createdAt = '2026-09-01T12:00:00.000Z';
	const access = { spaceType: MEMBERS_SPACE_TYPE, roles: ABOUT_SPACE_READER_ROLES, public: false };
	return [
		...GROUP_ROLES.map((role) => record(GROUP_ROLE_COLLECTION, role, { displayName: role })),
		record(GROUP_PERMISSIONS_COLLECTION, GROUP_PERMISSIONS_RKEY, HOST_PERMISSIONS),
		record(GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY, groupAccessRecord(access)),
		...Object.entries(roster).map(([did, role]) =>
			record(
				GROUP_MEMBERSHIP_COLLECTION,
				did,
				groupMembershipRecord({ subject: did, roles: [role], createdAt })
			)
		)
	];
}

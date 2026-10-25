// The members space as the group host seeds it (spike/host.mjs `seedRecords`): the two
// role records, the `permissions` record, the space's `access`, and a membership per member.
import { SPACE_SKEY, spaceUri } from '../../ids';
import { GROUP_ROLES, type GroupRoleName } from '../../permissions';
import { MEMBERS_SPACE_TYPE } from '../../types';
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
	const createdAt = '2026-09-01T12:00:00.000Z';
	return [
		...GROUP_ROLES.map((role) => ({
			space,
			collection: GROUP_ROLE_COLLECTION,
			rkey: role,
			value: { $type: GROUP_ROLE_COLLECTION, displayName: role }
		})),
		{
			space,
			collection: GROUP_PERMISSIONS_COLLECTION,
			rkey: GROUP_PERMISSIONS_RKEY,
			value: { ...HOST_PERMISSIONS, $type: GROUP_PERMISSIONS_COLLECTION }
		},
		{
			space,
			collection: GROUP_ACCESS_COLLECTION,
			rkey: GROUP_ACCESS_RKEY,
			value: {
				...groupAccessRecord({
					spaceType: MEMBERS_SPACE_TYPE,
					roles: ABOUT_SPACE_READER_ROLES,
					public: false
				}),
				$type: GROUP_ACCESS_COLLECTION
			}
		},
		...Object.entries(roster).map(([did, role]) => ({
			space,
			collection: GROUP_MEMBERSHIP_COLLECTION,
			rkey: did,
			value: {
				...groupMembershipRecord({ subject: did, roles: [role], createdAt }),
				$type: GROUP_MEMBERSHIP_COLLECTION
			}
		}))
	];
}

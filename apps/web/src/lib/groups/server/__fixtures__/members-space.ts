// The members space as the group host seeds it (spike/host.mjs `seedRecords`): the two
// role records, the `permissions` record, the space's `access`, and a membership per
// member. In memory through ./space-reader.ts, or written through a host's transport.
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
import {
	spaceReader,
	type FakeSpaceReader,
	type SpaceReaderOptions,
	type SpaceRecordInput
} from './space-reader';
import type { GroupRow } from '../../types';
import { pdsSpaceReader } from '../about-read';
import { gatedWriter, pdsWriter } from '../group-write';
import { putGroupMembership, type WriteGroupMembersInput } from '../members-writer';
import type { CredentialStoreEnv, GroupCredential } from '../session';

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

export function membersSpaceReader(
	space: string,
	groupDid: string,
	members: string[]
): FakeSpaceReader {
	return spaceReader(groupDid, {
		space,
		records: authzRecords(groupDid, Object.fromEntries(members.map((did) => [did, 'member'])))
	});
}

/** Each record names its space, so a host holding other spaces can hold these too. */
export function authzRecords(
	groupDid: string,
	roster: Record<string, GroupRoleName>
): SpaceRecordInput[] {
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

/** The members space as a create leaves it, in memory, for a test's gate. */
export function authzReader(
	groupDid: string,
	roster: Record<string, GroupRoleName>,
	options: SpaceReaderOptions = {}
): FakeSpaceReader {
	return spaceReader(groupDid, {
		space: spaceUri(groupDid, MEMBERS_SPACE_TYPE, SPACE_SKEY),
		...options,
		records: [...authzRecords(groupDid, roster), ...(options.records ?? [])]
	});
}

/** Puts, with `input`'s writer, what the host seeds into the members space, without
 *  any membership. */
export async function writeAuthzRecords(input: WriteGroupMembersInput): Promise<void> {
	const writer = await gatedWriter(input);
	for (const record of authzRecords(input.group.group_did, {})) {
		await writer({
			repo: input.group.group_did,
			collection: record.collection,
			rkey: record.rkey,
			record: record.value,
			intent: 'update',
			space: record.space
		});
	}
}

/** Writes, as the group, the seeded records and a membership for each DID in `roster`,
 *  for a test whose gate reads ./group-host.ts. */
export async function publishAuthz(input: {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	credential: GroupCredential;
	roster: Record<string, GroupRoleName>;
}): Promise<void> {
	const groupDid = input.group.group_did;
	const writer = pdsWriter(input.credential, groupDid);
	const asGroup = {
		db: input.db,
		env: input.env,
		group: input.group,
		callerDid: groupDid,
		writer,
		reader: pdsSpaceReader(input.credential, groupDid)
	};
	await writeAuthzRecords(asGroup);
	for (const [subject, role] of Object.entries(input.roster)) {
		await putGroupMembership({ ...asGroup, subject, roles: [role], intent: 'admit' });
	}
}

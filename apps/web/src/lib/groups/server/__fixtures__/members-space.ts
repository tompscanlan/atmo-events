// A members space whose authz config is written, holding a membership record
// for each of the given DIDs and for nobody else. That is the state a
// revocation leaves when the record delete succeeded and the row delete did
// not: `getCallerMembership` reads the record, not the row, and answers "off the
// roster".
//
// Test harness only. It is the in-memory reader of ./space-reader.ts, so its
// call log can also prove that no record was read at all. It holds no space
// configuration of its own: a members space holds no answer about the about
// space's, so a test that needs one passes the about space's `policies`.
import { SPACE_SKEY, spaceUri } from '../../ids';
import { DEFAULT_ROLE_PERMISSIONS, GROUP_ROLES, type GroupRoleName } from '../../permissions';
import { MEMBERS_SPACE_TYPE } from '../../types';
import {
	GROUP_EVENT_PERMISSIONS_COLLECTION,
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord
} from '../../members-record';
import {
	spaceReader,
	type FakeSpaceReader,
	type SpaceReaderOptions,
	type SpaceRecordInput
} from './space-reader';
import type { GroupRow } from '../../types';
import { pdsSpaceReader } from '../about-read';
import { pdsWriter } from '../group-write';
import { putGroupMembership, writeGroupAuthz } from '../members-writer';
import type { CredentialStoreEnv, GroupCredential } from '../session';

export function membersSpaceReader(
	space: string,
	groupDid: string,
	members: string[],
	policies?: SpaceReaderOptions['policies']
): FakeSpaceReader {
	return spaceReader(groupDid, {
		space,
		policies,
		records: [
			{
				collection: GROUP_ROLE_COLLECTION,
				rkey: 'member',
				value: { ...groupRoleRecord({ id: 'member' }), $type: GROUP_ROLE_COLLECTION }
			},
			{
				collection: GROUP_PERMISSIONS_COLLECTION,
				rkey: GROUP_PERMISSIONS_RKEY,
				value: {
					...groupBindingsRecord({ altitude: 'community', bundles: DEFAULT_ROLE_PERMISSIONS }),
					$type: GROUP_PERMISSIONS_COLLECTION
				}
			},
			...members.map((did) => ({
				collection: GROUP_MEMBERSHIP_COLLECTION,
				rkey: did,
				value: {
					...groupMembershipRecord({ subject: did, roles: ['member'] }),
					$type: GROUP_MEMBERSHIP_COLLECTION
				}
			}))
		]
	});
}

/** The records a create leaves in the members space: a `role` record per role,
 *  both binding records with atmo's default bundles, and a `membership` for each
 *  DID in `roster` with its role. Each names its space, so a host that holds
 *  other spaces' records too can hold these beside them. */
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
			value: { ...groupRoleRecord({ id: role }), $type: GROUP_ROLE_COLLECTION }
		})),
		{
			space,
			collection: GROUP_PERMISSIONS_COLLECTION,
			rkey: GROUP_PERMISSIONS_RKEY,
			value: {
				...groupBindingsRecord({ altitude: 'community', bundles: DEFAULT_ROLE_PERMISSIONS }),
				$type: GROUP_PERMISSIONS_COLLECTION
			}
		},
		{
			space,
			collection: GROUP_EVENT_PERMISSIONS_COLLECTION,
			rkey: GROUP_PERMISSIONS_RKEY,
			value: {
				...groupBindingsRecord({
					altitude: 'modality',
					bundles: DEFAULT_ROLE_PERMISSIONS,
					createdAt
				}),
				$type: GROUP_EVENT_PERMISSIONS_COLLECTION
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

/** The members space as a create leaves it, in memory (`authzRecords`). The gate
 *  resolves a caller from these, so a test of something the gate guards hands
 *  this as its reader and keeps the host's log for the writes under test. */
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

/** Writes, as the group, the records a create leaves in its members space at a
 *  host: the authz config and a membership for each DID in `roster`. For a test
 *  whose gate reads the host (a stub PDS) rather than an in-memory reader. The
 *  group's own DID passes the gate, as at create. */
export async function publishAuthz(input: {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	credential: GroupCredential;
	roster: Record<string, GroupRoleName>;
}): Promise<void> {
	const groupDid = input.group.group_did;
	const asGroup = {
		db: input.db,
		env: input.env,
		group: input.group,
		callerDid: groupDid,
		writer: pdsWriter(input.credential, groupDid),
		reader: pdsSpaceReader(input.credential, groupDid)
	};
	await writeGroupAuthz(asGroup);
	for (const [subject, role] of Object.entries(input.roster)) {
		await putGroupMembership({ ...asGroup, subject, roles: [role], intent: 'admit' });
	}
}

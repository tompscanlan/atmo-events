// A members space whose authz config is written, holding a membership record
// for each of the given DIDs and for nobody else. That is the state a
// revocation leaves when the record delete succeeded and the row delete did
// not: `getCallerMembership` reads the record, not the row, and answers "off the
// roster".
//
// Test harness only. It is the in-memory reader of ./space-reader.ts, so its
// call log can also prove that no record was read at all. It holds no space
// configuration: a members space holds no answer about the about space's.
import { DEFAULT_ROLE_PERMISSIONS } from '../../permissions';
import {
	GROUP_MEMBERSHIP_COLLECTION,
	GROUP_PERMISSIONS_COLLECTION,
	GROUP_PERMISSIONS_RKEY,
	GROUP_ROLE_COLLECTION,
	groupBindingsRecord,
	groupMembershipRecord,
	groupRoleRecord
} from '../../members-record';
import { spaceReader, type FakeSpaceReader } from './space-reader';

export function membersSpaceReader(
	space: string,
	groupDid: string,
	members: string[]
): FakeSpaceReader {
	return spaceReader(groupDid, {
		space,
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

// A members space whose authz config is written, holding a membership record
// for each of the given DIDs and for nobody else. That is the state a
// revocation leaves when the record delete succeeded and the row delete did
// not: `getCallerMembership` reads the record, not the row, and answers "off the
// roster".
//
// Test harness only. It counts every read, so a case can also prove that no
// record was read at all.
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
import type { GroupSpaceReader } from '../about-read';

export interface CountingSpaceReader extends GroupSpaceReader {
	/** Every get and list this reader has answered. */
	reads: number;
}

export function membersSpaceReader(
	space: string,
	groupDid: string,
	members: string[]
): CountingSpaceReader {
	const records = [
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
	].map((r) => ({
		...r,
		uri: `${space}/${groupDid}/${r.collection}/${r.rkey}`,
		cid: 'bafytest'
	}));

	const reader: CountingSpaceReader = {
		reads: 0,
		async get(query) {
			reader.reads++;
			return (
				records.find((r) => r.collection === query.collection && r.rkey === query.rkey) ?? null
			);
		},
		async list(query) {
			reader.reads++;
			return records.filter((r) => !query.collection || r.collection === query.collection);
		}
	};
	return reader;
}

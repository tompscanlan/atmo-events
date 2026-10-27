// The members space as the group host seeds it (./host-records.ts), in memory through
// ./space-reader.ts, or written through a host's transport.
import { SPACE_SKEY, spaceUri } from '../../ids';
import type { GroupRoleName } from '../../permissions';
import { MEMBERS_SPACE_TYPE } from '../../types';
import { spaceReader, type FakeSpaceReader, type SpaceReaderOptions } from './space-reader';
import { gatedWriter } from '../group-write';
import { authzRecords } from './host-records';

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
export async function writeAuthzRecords(input: Parameters<typeof gatedWriter>[0]): Promise<void> {
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

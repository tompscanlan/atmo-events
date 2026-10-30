// A GroupSpaceReader over fixed records, as a host answers someone it lets read them.
import { spaceRecordUri } from '../../ids';
import type { GroupSpaceReader } from '../space-read';
import type { HostRecord } from './host-records';

export function recordsReader(
	groupDid: string,
	records: readonly HostRecord[],
	opts: { ignoreCollectionFilter?: boolean } = {}
): GroupSpaceReader {
	const toRecord = (r: HostRecord) => ({
		uri: spaceRecordUri(r.space, groupDid, r.collection, r.rkey),
		cid: 'bafy',
		collection: r.collection,
		rkey: r.rkey,
		value: r.value
	});
	return {
		async get(q) {
			const found = records.find(
				(r) => r.space === q.space && r.collection === q.collection && r.rkey === q.rkey
			);
			return found ? toRecord(found) : null;
		},
		async list(q) {
			return records
				.filter((r) => r.space === q.space)
				.filter(
					(r) => opts.ignoreCollectionFilter || !q.collection || r.collection === q.collection
				)
				.map(toRecord);
		}
	};
}

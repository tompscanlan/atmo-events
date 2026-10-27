// A group's public events, through the same index as every other actor's. Every write
// notifies the index. Not the `$lib/contrail` barrel, which pulls in a stylesheet.
import { getServerClient } from '$lib/contrail/index';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import type { RsvpAtmoEventListRecords } from '../../../lexicon-types';
import type { GroupEventRecord, GroupRow } from '../types';

/** Logged, not thrown: a failed write would invite a retry of a write that landed. */
export async function notifyIndexQuietly(db: D1Database, uri: string): Promise<void> {
	try {
		await notifyIndex(db, uri);
	} catch (e) {
		console.error(`[groups] could not tell the index about ${uri}:`, e);
	}
}

/** By the record's `createdAt`, since a backfill stamps a repo with one ingest time. */
export async function listGroupEvents(
	db: D1Database,
	group: GroupRow,
	limit = 50
): Promise<GroupEventRecord[]> {
	const res = await getServerClient(db).get(
		'rsvp.atmo.event.listAuthored' as 'rsvp.atmo.event.listRecords',
		{
			params: {
				actor: group.group_did as ActorIdentifier,
				sort: 'createdAt',
				order: 'desc',
				limit: Math.min(Math.max(limit, 1), 200)
			}
		}
	);
	if (!res.ok) return [];

	return res.data.records.map((record: RsvpAtmoEventListRecords.Record) => ({
		uri: record.uri,
		cid: record.cid ?? '',
		rkey: record.rkey,
		value: record.value as unknown as Record<string, unknown>
	}));
}

export async function notifyIndex(db: D1Database, uri: string): Promise<void> {
	const res = await getServerClient(db).post('rsvp.atmo.notifyOfUpdate', {
		input: { uris: [uri as ResourceUri] }
	});
	if (!res.ok) throw new Error(`the index refused ${uri}`);
	if (res.data.errors?.length) {
		throw new Error(`the index rejected ${uri}: ${res.data.errors.join('; ')}`);
	}
}

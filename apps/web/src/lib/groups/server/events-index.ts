// A group's public events, read through the same index as every other actor's. They
// live in the group's public repo, not a space, because a space refuses anonymous
// readers. The index stays current two ways: an actor-scoped query backfills the repo
// once, and every gated write notifies the index with the URI it wrote. The client
// comes from `$lib/contrail/index`, not the barrel, which pulls in a stylesheet.
import { getServerClient } from '$lib/contrail/index';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import type { RsvpAtmoEventListRecords } from '../../../lexicon-types';
import type { GroupEventRecord, GroupRow } from '../types';

/** Hands the index a URI a writer just wrote, an event or a declaration. A seam,
 *  so tests need no appview. */
export type IndexNotifier = (uri: string) => Promise<void>;

/** Tells the index about a write the PDS already took. A failure is logged, not
 *  thrown: reporting a failed write would invite a retry of a write that landed. */
export async function notifyIndexQuietly(
	db: D1Database,
	uri: string,
	notify?: IndexNotifier
): Promise<void> {
	try {
		await (notify ?? contrailNotifier(db))(uri);
	} catch (e) {
		console.error(`[groups] could not tell the index about ${uri}:`, e);
	}
}

/** The group's public events, newest first by the record's own `createdAt`, since a
 *  backfill stamps a whole repo with one ingest time. */
export async function listGroupEvents(
	db: D1Database,
	group: GroupRow,
	limit = 50
): Promise<GroupEventRecord[]> {
	// `listAuthored` answers in the `listRecords` shape. The generated types know only
	// the endpoints that have a published lexicon.
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

/** Hands a just-written URI to the index, which re-fetches it and applies a create,
 *  update or delete. Throws what the index reports; the write gate decides what to show. */
export function contrailNotifier(db: D1Database): IndexNotifier {
	return async (uri: string) => {
		const res = await getServerClient(db).post('rsvp.atmo.notifyOfUpdate', {
			input: { uris: [uri as ResourceUri] }
		});
		if (!res.ok) throw new Error(`the index refused ${uri}`);
		if (res.data.errors?.length) {
			throw new Error(`the index rejected ${uri}: ${res.data.errors.join('; ')}`);
		}
	};
}

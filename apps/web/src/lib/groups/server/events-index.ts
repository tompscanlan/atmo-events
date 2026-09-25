// A group's public events, read through the same index as every other actor's.
//
// They live in the group DID's public repo, not in a space, because a space
// refuses anonymous HTTP readers even under a public policy (401 AuthMissing),
// and /groups/<did>/events must render for a visitor who is not logged in.
// They are read through the index, not from the repo on each page view,
// because they are ordinary `community.lexicon.calendar.event` records: the
// index gives them cursors, joins and RSVP counts, does not tie a page to
// someone else's PDS, and lets a group event appear in a feed, a search or a
// profile listing without a second code path.
//
// The index is a projection, so it must not silently lag behind the repo. Two
// mechanisms prevent that, and both need the indexer to know where the group's
// repo is, which is what `registerGroupIdentity` records at mint:
//
//   1. an actor-scoped query backfills that repo on demand, once, so a cold
//      index fills itself on the first visit instead of showing an empty tab;
//   2. every write through the gate notifies the index with the URI it just
//      wrote, so a later edit does not wait for the next cron tick to pull it
//      off Jetstream. Without this, every edit after the backfill would be
//      invisible until then.
//
// The client comes from `$lib/contrail/index`, not the `$lib/contrail` barrel:
// the barrel re-exports the event-card helpers, which pull in a stylesheet, and
// the write gate is server-only code that must load without a browser.
import { getServerClient } from '$lib/contrail/index';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import type { RsvpAtmoEventListRecords } from '../../../lexicon-types';
import type { GroupEventRecord, GroupRow } from '../types';

/** Records where a group's repo lives, in the table the index resolves DIDs
 *  through, so it can fetch that repo's records.
 *
 *  Called at mint with what the account creation just returned. That is a
 *  stronger source than reading the same PDS back, and cheaper: one statement,
 *  no round trip. The handle is included because the mint knows it;
 *  `./handles.ts` owns the case where a handle comes from a later read, and
 *  keeps the verification that case needs.
 *
 *  COALESCE so a partial write never clobbers a value already resolved: the
 *  mint knows the PDS first-hand, a later refresh knows the handle, and neither
 *  may erase the other's.
 *
 *  Returns false when the row did not land. Callers may report that but must
 *  not treat it as fatal: the index falls back to resolving the DID over the
 *  public network, and this must not fail a group's creation. It also keeps a
 *  database with no `identities` table (a scratch D1 seeded from `migrations/`
 *  alone) usable. */
export async function registerGroupIdentity(
	db: D1Database,
	identity: { did: string; handle: string | null; pds: string | null }
): Promise<boolean> {
	try {
		await db
			.prepare(
				`INSERT INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, ?)
				 ON CONFLICT (did) DO UPDATE SET
					handle = COALESCE(excluded.handle, identities.handle),
					pds = COALESCE(excluded.pds, identities.pds),
					resolved_at = excluded.resolved_at`
			)
			.bind(identity.did, identity.handle, identity.pds, Date.now())
			.run();
		return true;
	} catch {
		return false;
	}
}

/** What the write gate calls with the URI it just wrote, so the index does not
 *  have to discover the write on its own. A seam rather than a direct call, so
 *  the gate's tests can check that a write notifies without an appview. */
export type GroupEventNotifier = (uri: string) => Promise<void>;

/** The group's public events, newest first.
 *
 *  Ordered by the record's own `createdAt` rather than by ingest time, because
 *  ingest time is when we happened to hear about a record: a backfill stamps a
 *  whole repo at once and would scramble the order, while the record's field
 *  reads the same however it arrived.
 *
 *  Conference talks are excluded: an event that belongs to a parent conference
 *  is listed under that conference, not beside it. No group event has a parent
 *  today, but every event surface in this app assumes this. */
export async function listGroupEvents(
	db: D1Database,
	group: GroupRow,
	limit = 50
): Promise<GroupEventRecord[]> {
	// `listAuthored` is a pipeline query over the same collection as
	// `listRecords` and answers in the same shape, which is what the cast says;
	// the generated types only know the endpoints that have a published lexicon.
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

/** Hands one just-written URI to the index, which re-fetches the record from
 *  the group's PDS and applies a create, an update or (when the record is gone)
 *  a delete.
 *
 *  Throws what the index reports and does nothing else. Whether a failure may
 *  be shown to the person who pressed save is a question about the write, so
 *  the write gate decides it, once for every notifier. */
export function contrailNotifier(db: D1Database): GroupEventNotifier {
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

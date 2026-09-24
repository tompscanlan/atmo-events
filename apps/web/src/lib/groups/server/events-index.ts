// A group's PUBLIC event slice, through the index every other actor's events
// come through.
//
// WHY THE PUBLIC REPO AND NOT THE GROUP'S SPACE. A repo's records are
// anonymously readable; a space refuses an anonymous HTTP reader even under a
// public policy (measured: 401 AuthMissing). So the public slice is written to
// the group DID's own repo, and /groups/<did>/events renders for a visitor who
// has never logged in.
//
// WHY THE INDEX AND NOT THE REPO DIRECTLY. A public repo record is exactly what
// an appview is for, and reading one actor's repo over HTTP on every page view
// is the thing an appview exists to stop: no cursor reuse, no joins, no RSVP
// counts, and a page that is only as fast as someone else's PDS. Group events
// are `community.lexicon.calendar.event` records like any other, so they belong
// in the same D1 the rest of the app reads — which also means a group event can
// appear in a feed, a search or a profile listing without a second code path.
//
// WHAT MAKES THE INDEX SAFE TO READ. It is a projection, so it is only correct
// while it cannot silently lag behind the repo. Two mechanisms close that, and
// both need the indexer to know where the group's repo is, which is the row
// `registerGroupIdentity` writes below at mint:
//
//   1. an actor-scoped query backfills that actor's repo on demand, once, so a
//      cold index fills itself on the first visit rather than showing an empty
//      tab; and
//   2. every write through the gate notifies the index with the URI it just
//      wrote, so the second and every later event does not wait for the
//      backfill that already completed, nor for the next cron tick to pull it
//      off Jetstream (which does carry the alpha PDS, measured 2026-09-24).
//
// Without (2) the first read would look right and every edit after it would be
// invisible, which is the failure this module is shaped to prevent.
//
// The client comes from `$lib/contrail/index` rather than the `$lib/contrail`
// barrel on purpose: the barrel re-exports the shared event-card helpers, which
// drag a stylesheet into every module that touches it, and the write gate is
// server-only code that must stay importable without a browser environment.
import { getServerClient } from '$lib/contrail/index';
import type { ActorIdentifier } from '@atcute/lexicons';
import type { ResourceUri } from '@atcute/lexicons/syntax';
import type { RsvpAtmoEventListRecords } from '../../../lexicon-types';
import type { GroupEventRecord, GroupRow } from '../types';

/** Records where a group's repo lives, in the one table the index resolves
 *  DIDs through, so it can fetch that repo's records at all.
 *
 *  Called at mint with what the account creation just returned, which is both
 *  a stronger source than reading the same PDS back and cheaper — one
 *  statement, no round trip. The handle rides along because the row holds it
 *  and the mint knows it; `./handles.ts` owns the case where a handle's
 *  provenance is a later read, and keeps the verification that case needs.
 *
 *  COALESCE so a partial write never clobbers a value already resolved: the
 *  mint knows the PDS first-hand, a later refresh knows the handle, and neither
 *  may erase the other's.
 *
 *  Returns false when the row did not land, which callers may report but must
 *  not treat as fatal: the index falls back to resolving the DID over the
 *  public network, and this is not allowed to fail a group's creation. It is
 *  also how a database with no `identities` table at all — a scratch D1 seeded
 *  from `migrations/` alone — stays usable. */
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
 *  have to discover the write on its own. A seam rather than a direct call so
 *  the gate's tests can assert that a write notifies without standing up an
 *  appview. */
export type GroupEventNotifier = (uri: string) => Promise<void>;

/** The group's public events, newest first.
 *
 *  Ordered by the record's own `createdAt` rather than by ingest time, because
 *  ingest time is when we happened to hear about a record: a backfill stamps a
 *  whole repo at once and would scramble the order, while the record's field
 *  reads the same however it arrived.
 *
 *  Conference talks are excluded — an event that belongs to a parent conference
 *  is listed under that conference, not beside it — which no group event has
 *  today but every event surface in this app already assumes. */
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
 *  the group's PDS and applies a create, an update or — when the record is gone
 *  — a delete.
 *
 *  Raises what the index says and otherwise gets out of the way. Whether a
 *  failure here may be shown to the person who pressed save is a question about
 *  the WRITE, so the write gate answers it — once, for every notifier, rather
 *  than once per implementation here. */
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

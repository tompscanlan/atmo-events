// The read half of ./declaration-writer.ts: which groups the network has
// declared, as this deployment's own index heard it.
//
// The list is `rsvp.atmo.declaration.listRecords`, built off Jetstream. It
// holds every actor's declaration, not only the groups we host, because
// contrail discovers the collection network-wide. Browse lists them all, and
// `listGroups` decides what each one may show.
//
// Always unscoped. An `actor` parameter backfills that repo on demand, which
// would make a group appear because someone looked for it rather than because
// the index heard it. And no `profiles`: contrail refetches a missing profile
// from the actor's PDS on every call and caches no miss, so a group with no
// `app.bsky.actor.profile` would cost one PDS round trip per browse view.
// Handles come from `./handles.ts`, which reads the cache without a fetch.
//
// A declaration written before the collection was added to the indexer config
// is not in the index until a one-time `contrail backfill --only records`:
// discovery is keyed per (collection, relay), so a collection new to the config
// is walked from the relay's first page.
import { getServerClient } from '$lib/contrail/index';
import type { DeclaredGroup } from './repo';

/** Newest declaration first, by the record's own `createdAt`: the writer keeps
 *  it when a group goes private and back, so a re-declared group keeps its place.
 *
 *  Throws when the index does not answer. An empty list would render as "No
 *  groups yet", which is a claim about the network rather than about our D1,
 *  and a page must not stand in for a read it could not make. */
export async function listDeclaredGroups(db: D1Database, limit = 100): Promise<DeclaredGroup[]> {
	const res = await getServerClient(db).get('rsvp.atmo.declaration.listRecords', {
		params: { sort: 'createdAt', order: 'desc', limit: Math.min(Math.max(limit, 1), 200) }
	});
	if (!res.ok) throw new Error(`the declaration index did not answer: ${res.data.error}`);

	return res.data.records.map((record) => {
		const createdAt = (record.value as { createdAt?: unknown } | null)?.createdAt;
		return { did: record.did, createdAt: typeof createdAt === 'string' ? createdAt : null };
	});
}

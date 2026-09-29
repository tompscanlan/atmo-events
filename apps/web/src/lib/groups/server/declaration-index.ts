import { getServerClient } from '$lib/contrail/index';
import type { DeclaredGroup } from './repo';

/** Every group declared on the network, newest first. Throws if the index fails.
 *  No `actor`, which would backfill that repo on demand, and no `profiles`, since
 *  contrail refetches a missing profile from its PDS on every call. */
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

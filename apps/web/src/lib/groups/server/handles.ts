// A group's HANDLE, for display.
//
// It is not a column: the group row carries the DID and no name beside it
// (FR-001a), so the handle is read from the DID document and cached — and the
// cache we already have is contrail's `identities` table, in this same D1,
// which is where every other actor's handle on this deployment comes from. A
// group we have never resolved shows its DID, which is not a failure: it is
// the key every link carries anyway.
//
// The row itself is written by `./events-index.ts`, because the column that
// matters most on it is the PDS, and what that column is FOR is letting the
// index fetch the group's records. This module is the half that decides what a
// reader is allowed to SEE.
//
// WHY A SEPARATE MODULE RATHER THAN `repo.ts`: `identities` is contrail's table,
// not ours. Reads here tolerate its absence, because a scratch D1 seeded with
// only `migrations/` has no such table and the groups surface must still
// render. That tolerance is about an optional display cache — it is NOT the
// outage fallback FR-010 forbids, which is about record CONTENT.
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import { getPDS } from '$lib/atproto/methods';
import { registerGroupIdentity } from './events-index';

/** `handle` may be NULL in contrail's schema, so a row is not a handle. */
interface IdentityRow {
	did: string;
	handle: string | null;
}

/** Handles contrail already knows, for the DIDs asked about. Missing keys mean
 *  "show the DID", never "the group is broken". */
export async function knownHandles(db: D1Database, dids: string[]): Promise<Map<string, string>> {
	const found = new Map<string, string>();
	if (dids.length === 0) return found;
	const placeholders = dids.map(() => '?').join(', ');
	try {
		const { results } = await db
			.prepare(`SELECT did, handle FROM identities WHERE did IN (${placeholders})`)
			.bind(...dids)
			.all<IdentityRow>();
		for (const row of results ?? []) {
			if (row.handle) found.set(row.did, row.handle);
		}
	} catch {
		// No `identities` table on this database. Display falls back to DIDs.
	}
	return found;
}

/** Reads the handle the group's own PDS reports for it and writes it into
 *  contrail's cache.
 *
 *  `handleIsCorrect` is the bidirectional check — the DID document claims the
 *  handle AND the handle resolves back to the DID. A handle that fails it is
 *  NOT displayed: an unverified handle is exactly the takeover risk FR-010a
 *  mitigates by publishing DIDs, and showing one would undo that. Any failure
 *  (PDS unreachable, no such repo, no `identities` table) returns null and the
 *  caller shows the DID. */
export async function refreshGroupHandle(db: D1Database, groupDid: string): Promise<string | null> {
	let service: string | null = null;
	try {
		service = (await getPDS(groupDid as Did)) ?? null;
	} catch {
		return null;
	}
	if (!service) return null;

	const client = new Client({ handler: simpleFetchHandler({ service }) });
	const res = await client.get('com.atproto.repo.describeRepo', {
		params: { repo: groupDid as Did }
	});
	if (!res.ok) return null;
	if (!res.data.handleIsCorrect) return null;
	const handle = res.data.handle;

	await registerGroupIdentity(db, { did: groupDid, handle, pds: service });
	return handle;
}

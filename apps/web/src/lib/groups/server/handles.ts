// A group's handle, for display, from Contrail's `identities` cache in this D1. A group
// never resolved shows its DID, which every link uses anyway. A D1 set up from
// `migrations/` alone has no `identities`, so reads here tolerate its absence.
import { Client, simpleFetchHandler } from '@atcute/client';
import type { Did } from '@atcute/lexicons';
import { getPDS } from '$lib/atproto/methods';
import { registerGroupIdentity } from './events-index';

interface IdentityRow {
	did: string;
	handle: string | null;
}

/** Handles Contrail already knows. A missing key means "show the DID". */
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

/** Reads the handle the group's PDS reports and caches it. A handle that fails the
 *  two-way check (`handleIsCorrect`) is not shown, since an unverified handle is a
 *  takeover risk. Returns null when the PDS cannot be asked; the caller shows the DID. */
export async function refreshGroupHandle(db: D1Database, groupDid: string): Promise<string | null> {
	let service: string | null;
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

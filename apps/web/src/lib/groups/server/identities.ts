// A group in Contrail's `identities` cache in this D1: its handle, for display, and
// where its repo lives, which the index resolves the group's DID through. A group
// never resolved shows its DID, which every link uses anyway. A D1 set up from
// `migrations/` alone has no `identities`, so reads and writes here tolerate its
// absence.

/** Records where a group's repo lives, in the table the index resolves DIDs through.
 *  COALESCE, so a partial write never erases a value already resolved. Returns false
 *  when the row did not land, which is not fatal: the index can still resolve the DID
 *  over the network, and a D1 seeded from `migrations/` alone has no `identities`. */
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

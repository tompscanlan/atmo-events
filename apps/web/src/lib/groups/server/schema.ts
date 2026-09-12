// Applies migrations/0001_groups.sql to D1.
//
// One copy of the DDL, two runners: `wrangler d1 migrations apply` /
// `wrangler d1 execute --file` for a deliberate deploy, and this module for the
// self-heal the rest of the app already does for its own tables
// (ensureGeocodeDripSchema, runGeocodeJob's geocode_cache, contrail's init). The
// file is imported `?raw` rather than duplicated as a TS string array so the two
// can never disagree.
import migrationSql from '../../../../migrations/0001_groups.sql?raw';

/** Statements in apply order. Split on the `-- @statement` marker, never on
 *  `;` — the owner-protection triggers contain `;` inside BEGIN..END and a
 *  naive split would feed D1 half a trigger. */
export const GROUPS_SCHEMA_STATEMENTS: readonly string[] = migrationSql
	.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m)
	.map((s) => s.trim())
	.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s));

// Module-level, exactly like contrail's own `initialized` flag in
// $lib/contrail/index.ts: one isolate, one D1 binding, one apply.
let applied: Promise<void> | null = null;

/** Idempotent (`IF NOT EXISTS` throughout) and once per isolate. Runs as one
 *  `batch()` so a half-applied schema is impossible: D1 executes a batch inside
 *  a single transaction.
 *
 *  `async` is load-bearing, not decoration: `db.prepare` runs SYNCHRONOUSLY, so
 *  without it a bad binding throws out of a promise-returning call and no
 *  caller's `.catch` can see it — including the one in $lib/contrail/index.ts
 *  that keeps a groups failure from stopping contrail's ingest. It also means
 *  `applied` is never assigned on that path, so the next request retries. */
export async function ensureGroupsSchema(db: D1Database): Promise<void> {
	applied ??= db
		.batch(GROUPS_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)))
		.then(() => undefined)
		.catch((e) => {
			// Do not cache a failure: the next request retries rather than serving a
			// permanently broken groups surface for the isolate's lifetime.
			applied = null;
			throw e;
		});
	return applied;
}

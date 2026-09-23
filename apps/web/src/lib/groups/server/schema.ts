// Applies every file in migrations/ to D1, in order.
//
// One copy of the DDL, two runners: `wrangler d1 migrations apply` /
// `wrangler d1 execute --file` for a deliberate deploy, and this module for the
// self-heal the rest of the app already does for its own tables
// (ensureGeocodeDripSchema, runGeocodeJob's geocode_cache, contrail's init). The
// files are imported `?raw` rather than duplicated as TS strings so the two
// runners can never disagree.
//
// Adding a migration means adding it to `MIGRATIONS` in order. A new file rather
// than an edit to 0001: `wrangler d1 migrations apply` tracks what it has run, so
// editing an applied migration would leave a deployed database without the new
// table and only the self-heal below would notice.
import groupsSql from '../../../../migrations/0001_groups.sql?raw';
import credentialsSql from '../../../../migrations/0002_group_credentials.sql?raw';
import privateInviteOnlySql from '../../../../migrations/0003_private_groups_are_invite_only.sql?raw';
import threeRoleSeedSql from '../../../../migrations/0004_three_role_seed.sql?raw';
import noSuspensionSql from '../../../../migrations/0005_no_suspension.sql?raw';

const MIGRATIONS: readonly string[] = [
	groupsSql,
	credentialsSql,
	privateInviteOnlySql,
	threeRoleSeedSql,
	noSuspensionSql
];

/** Statements per migration, in apply order. Split on the `-- @statement`
 *  marker, never on `;` — the owner-protection triggers contain `;` inside
 *  BEGIN..END and a naive split would feed D1 half a trigger.
 *
 *  The boundary is kept rather than flattened away because a data migration
 *  can only be tested against the database it migrates: 0004's reconcile needs
 *  a five-role database to reconcile, which is the state the first three
 *  migrations produce and the fourth then forbids. */
export const GROUPS_MIGRATION_STATEMENTS: readonly (readonly string[])[] = MIGRATIONS.map((sql) =>
	sql
		.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m)
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s))
);

export const GROUPS_SCHEMA_STATEMENTS: readonly string[] = GROUPS_MIGRATION_STATEMENTS.flat();

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

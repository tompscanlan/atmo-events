// Applies every file in migrations/ to D1, in order.
//
// One copy of the DDL, two runners: `wrangler d1 execute --file` for a
// deliberate deploy, and this module for the self-heal the app already does for
// its other tables (the geocode cache, Contrail's own init). The files are
// imported `?raw` rather than copied into TS strings, so the two runners cannot
// disagree.
//
// Adding a migration means adding a file and listing it in `MIGRATIONS`. Every
// statement must be safe to re-run, because this runs on every cold isolate.
import groupsSql from '../../../../migrations/0001_groups.sql?raw';
import credentialsSql from '../../../../migrations/0002_group_credentials.sql?raw';

const MIGRATIONS: readonly string[] = [groupsSql, credentialsSql];

/** Every statement, in apply order. Split on the `-- @statement` marker, never
 *  on `;`, because the triggers contain `;` inside BEGIN..END. */
export const GROUPS_SCHEMA_STATEMENTS: readonly string[] = MIGRATIONS.flatMap((sql) =>
	sql
		.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m)
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s))
);

/** Apply every statement to a synchronous SQLite handle (`node:sqlite`). For
 *  tests. */
export function applyGroupsSchemaSync(sqlite: { exec(sql: string): void }): void {
	for (const statement of GROUPS_SCHEMA_STATEMENTS) sqlite.exec(statement);
}

// Module-level, exactly like contrail's own `initialized` flag in
// $lib/contrail/index.ts: one isolate, one D1 binding, one apply.
let applied: Promise<void> | null = null;

/** Idempotent (`IF NOT EXISTS` throughout) and applied once per isolate. It
 *  runs as one `batch()`, and D1 runs a batch in a single transaction, so the
 *  schema is never half-applied.
 *
 *  Every function that touches a groups table awaits this before its first
 *  statement, so a fresh deployment gets the tables on its first groups call,
 *  with no deploy-time migration step. Nothing outside the groups code calls
 *  it, so a failed apply fails that groups call and nothing else.
 *
 *  `db.prepare` runs synchronously and throws on a bad binding, so it is called
 *  inside `.then`, where its error takes the same path as a failed batch.
 *
 *  A failure is not cached. If it were, one failed apply would leave the groups
 *  feature broken for the rest of the isolate's life. Instead `applied` is
 *  reset, so the next call tries again. */
export async function ensureGroupsSchema(db: D1Database): Promise<void> {
	applied ??= Promise.resolve()
		.then(() => db.batch(GROUPS_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql))))
		.then(() => undefined)
		.catch((e) => {
			// Forget the failure so the next call retries (see above).
			applied = null;
			throw e;
		});
	return applied;
}

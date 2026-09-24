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
import dropUnrenderedLocationSql from '../../../../migrations/0006_drop_unrendered_location.sql?raw';

const MIGRATIONS: readonly string[] = [
	groupsSql,
	credentialsSql,
	privateInviteOnlySql,
	threeRoleSeedSql,
	noSuspensionSql,
	dropUnrenderedLocationSql
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

const DROP_COLUMN = /^ALTER\s+TABLE\s+(\w+)\s+DROP\s+COLUMN\s+(\w+)$/i;

/** The table and column a statement drops, or null for any other statement.
 *  Leading comment lines are part of a statement after the split, so they are
 *  skipped before matching. */
export function droppedColumn(statement: string): { table: string; column: string } | null {
	const match = DROP_COLUMN.exec(statement.replace(/^(?:[ \t]*--[^\n]*\n)+/, '').trim());
	return match ? { table: match[1], column: match[2] } : null;
}

/** True when `statement` drops a column the database no longer has. SQLite has
 *  no `DROP COLUMN IF EXISTS`, so a column drop is the one statement in
 *  migrations/ that cannot be written to replay, and the runner skips it here
 *  instead.
 *
 *  An absent TABLE does not count as applied. On a fresh database the drop runs
 *  after 0001's `CREATE TABLE` in the same pass, which puts the column back, so
 *  the drop is still owed. `columnsOf` returns [] for a table that does not
 *  exist, which is what `pragma_table_info` returns for one. */
export function alreadyApplied(
	statement: string,
	columnsOf: (table: string) => readonly string[]
): boolean {
	const drop = droppedColumn(statement);
	if (!drop) return false;
	const columns = columnsOf(drop.table);
	return columns.length > 0 && !columns.includes(drop.column);
}

const COLUMNS_SQL = 'SELECT name FROM pragma_table_info(?)';

/** The statements this database still needs, read before the batch is built:
 *  a D1 batch cannot branch on what an earlier statement in it found. */
async function owedStatements(db: D1Database): Promise<string[]> {
	const columns = new Map<string, string[]>();
	for (const statement of GROUPS_SCHEMA_STATEMENTS) {
		const table = droppedColumn(statement)?.table;
		if (!table || columns.has(table)) continue;
		const { results } = await db.prepare(COLUMNS_SQL).bind(table).all<{ name: string }>();
		columns.set(
			table,
			results.map((row) => row.name)
		);
	}
	return GROUPS_SCHEMA_STATEMENTS.filter(
		(statement) => !alreadyApplied(statement, (table) => columns.get(table) ?? [])
	);
}

/** Apply every statement to a synchronous SQLite handle (`node:sqlite`), with
 *  the same skip `ensureGroupsSchema` makes. For tests. The column check runs
 *  immediately before each statement, so a fresh database drops what 0001 just
 *  created. */
export function applyGroupsSchemaSync(sqlite: {
	exec(sql: string): void;
	prepare(sql: string): { all(...args: string[]): unknown[] };
}): void {
	const columnsOf = (table: string) =>
		(sqlite.prepare(COLUMNS_SQL).all(table) as { name: string }[]).map((row) => row.name);
	for (const statement of GROUPS_SCHEMA_STATEMENTS) {
		if (!alreadyApplied(statement, columnsOf)) sqlite.exec(statement);
	}
}

// Module-level, exactly like contrail's own `initialized` flag in
// $lib/contrail/index.ts: one isolate, one D1 binding, one apply.
let applied: Promise<void> | null = null;

/** Idempotent (`IF NOT EXISTS` throughout, and a column drop skipped once its
 *  column is gone) and once per isolate. Runs as one `batch()` so a
 *  half-applied schema is impossible: D1 executes a batch inside a single
 *  transaction.
 *
 *  Two cold isolates can both read a column as present and both batch its
 *  drop. The second batch then fails whole and changes nothing, and that
 *  isolate's next request re-reads and finds nothing owed.
 *
 *  `async` is load-bearing, not decoration: `db.prepare` runs SYNCHRONOUSLY, so
 *  without it a bad binding throws out of a promise-returning call and no
 *  caller's `.catch` can see it — including the one in $lib/contrail/index.ts
 *  that keeps a groups failure from stopping contrail's ingest. It also means
 *  `applied` is never assigned on that path, so the next request retries. */
export async function ensureGroupsSchema(db: D1Database): Promise<void> {
	applied ??= owedStatements(db)
		.then((statements) => db.batch(statements.map((sql) => db.prepare(sql))))
		.then(() => undefined)
		.catch((e) => {
			// Do not cache a failure: the next request retries rather than serving a
			// permanently broken groups surface for the isolate's lifetime.
			applied = null;
			throw e;
		});
	return applied;
}

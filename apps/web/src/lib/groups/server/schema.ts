// Applies migrations/ to D1 on every cold isolate, so each statement must be safe to
// re-run. The files are imported `?raw`, so wrangler and this runner share one copy.
import groupsSql from '../../../../migrations/0001_groups.sql?raw';
import credentialsSql from '../../../../migrations/0002_group_credentials.sql?raw';

const MIGRATIONS: readonly string[] = [groupsSql, credentialsSql];

/** Split on the `-- @statement` marker, never on `;`: the triggers contain `;`. */
export const GROUPS_SCHEMA_STATEMENTS: readonly string[] = MIGRATIONS.flatMap((sql) =>
	sql
		.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m)
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s))
);

/** For tests, against a `node:sqlite` handle. */
export function applyGroupsSchemaSync(sqlite: { exec(sql: string): void }): void {
	for (const statement of GROUPS_SCHEMA_STATEMENTS) sqlite.exec(statement);
}

let applied: Promise<void> | null = null;

/** Applied once per isolate, as one `batch()` that D1 runs in a single transaction.
 *  `db.prepare` runs inside `.then` so its throw takes the batch's failure path. A
 *  failure is not cached, so the next call retries. */
export async function ensureGroupsSchema(db: D1Database): Promise<void> {
	applied ??= Promise.resolve()
		.then(() => db.batch(GROUPS_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql))))
		.then(() => undefined)
		.catch((e) => {
			applied = null;
			throw e;
		});
	return applied;
}

// Applies the groups migration to D1 on every cold isolate, so each statement must be
// safe to re-run. Imported `?raw`, so wrangler and this runner share one copy.
import groupsSql from '../../../../migrations/0001_groups.sql?raw';

export const GROUPS_SCHEMA_STATEMENTS: readonly string[] = groupsSql
	.split(/^[ \t]*--[ \t]*@statement[ \t]*$/m)
	.map((s) => s.trim())
	.filter((s) => s.length > 0 && !/^(?:--[^\n]*\n?)*$/.test(s));

export function applyGroupsSchemaSync(sqlite: { exec(sql: string): void }): void {
	for (const statement of GROUPS_SCHEMA_STATEMENTS) sqlite.exec(statement);
}

let applied: Promise<void> | null = null;

/** Once per isolate, as one `batch()`; a failure is not cached. */
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

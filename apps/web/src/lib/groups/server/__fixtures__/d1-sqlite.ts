// A D1Database over `node:sqlite`, so the groups tests exercise the REAL SQL —
// the triggers, the CHECKs, the partial unique indexes — instead of a mock that
// would agree with whatever the code did. D1 is SQLite, so the engine is the
// same one the invariants will be enforced by in production.
//
// Test harness only; it implements exactly the D1 surface $lib/groups/server
// uses (prepare/bind/all/first/run and batch-as-transaction).
import { DatabaseSync } from 'node:sqlite';
import { applyGroupsSchemaSync } from '../schema';

type Row = Record<string, unknown>;

interface Meta {
	changes: number;
	last_row_id: number;
	duration: number;
	size_after: number;
	rows_read: number;
	rows_written: number;
}

function meta(changes = 0, lastRowId = 0): Meta {
	return {
		changes,
		last_row_id: lastRowId,
		duration: 0,
		size_after: 0,
		rows_read: 0,
		rows_written: 0
	};
}

class Statement {
	constructor(
		private readonly db: DatabaseSync,
		private readonly sql: string,
		private readonly params: unknown[] = []
	) {}

	bind(...values: unknown[]) {
		return new Statement(this.db, this.sql, values);
	}

	private args() {
		// node:sqlite accepts null/number/string/bigint/Uint8Array. Booleans come
		// out of the app layer occasionally; SQLite has no boolean type.
		return this.params.map((p) => (typeof p === 'boolean' ? (p ? 1 : 0) : p)) as never[];
	}

	async all<T = Row>() {
		const results = this.db.prepare(this.sql).all(...this.args()) as T[];
		return { results, success: true, meta: meta(0) };
	}

	async first<T = Row>(column?: string) {
		const row = this.db.prepare(this.sql).get(...this.args()) as Row | undefined;
		if (!row) return null;
		return (column ? (row[column] as T) : (row as T)) ?? null;
	}

	async run() {
		const result = this.db.prepare(this.sql).run(...this.args());
		return {
			results: [],
			success: true,
			meta: meta(Number(result.changes), Number(result.lastInsertRowid))
		};
	}

	async raw() {
		const rows = this.db.prepare(this.sql).all(...this.args()) as Row[];
		return rows.map((row) => Object.values(row));
	}
}

export interface SqliteD1 {
	/** Pass this where the app expects `platform.env.DB`. */
	db: D1Database;
	/** The underlying handle, for a test that wants to poke at raw SQL. */
	raw: DatabaseSync;
	close(): void;
}

/** @param applySchema apply migrations/0001_groups.sql. Off for the migration
 *  test itself, which applies the statements deliberately (and twice, to prove
 *  idempotence). On everywhere else: `ensureGroupsSchema` memoises per isolate,
 *  so a second in-memory database in the same test file would otherwise get no
 *  schema at all. */
export function sqliteD1(applySchema = true): SqliteD1 {
	const sqlite = new DatabaseSync(':memory:');
	// D1 enforces foreign keys; plain SQLite does not unless told. Without this
	// the composite (role_id, group_id) -> roles(id, group_id) check — the whole
	// "a membership's role belongs to the same group" invariant — would silently
	// pass anything.
	sqlite.exec('PRAGMA foreign_keys = ON');
	if (applySchema) {
		applyGroupsSchemaSync(sqlite);
	}

	const api = {
		prepare: (sql: string) => new Statement(sqlite, sql),
		async batch(statements: { all(): Promise<unknown>; run(): Promise<unknown> }[]) {
			// D1 runs a batch in one transaction; so does this.
			sqlite.exec('BEGIN');
			try {
				const out = [];
				for (const statement of statements) out.push(await statement.run());
				sqlite.exec('COMMIT');
				return out;
			} catch (e) {
				sqlite.exec('ROLLBACK');
				throw e;
			}
		},
		async exec(sql: string) {
			sqlite.exec(sql);
			return { count: 0, duration: 0 };
		},
		async dump() {
			throw new Error('dump() is not implemented in the sqlite test harness');
		}
	};

	return {
		db: api as unknown as D1Database,
		raw: sqlite,
		close: () => sqlite.close()
	};
}

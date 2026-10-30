import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	queryRecords,
	resolveConfig,
	sqliteDialect,
	type Database,
	type Statement
} from '@atmo-dev/contrail';
import { config } from '../contrail.config';

const COLLECTION = 'group.opensocial.declaration';

/** contrail's declaration table in memory, with `declarations` as [did, rkey, time_us]. */
function setup(declarations: [string, string, number][]) {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(`CREATE TABLE records_declaration (
		uri TEXT PRIMARY KEY, did TEXT, rkey TEXT, cid TEXT, record TEXT,
		time_us INTEGER, indexed_at INTEGER
	);
	CREATE TABLE moderation_hidden (subject TEXT, cid TEXT, starts_at INTEGER, exp INTEGER)`);
	const insert = sqlite.prepare('INSERT INTO records_declaration VALUES (?, ?, ?, ?, ?, ?, ?)');
	for (const [did, rkey, time] of declarations) {
		insert.run(`at://${did}/${COLLECTION}/${rkey}`, did, rkey, 'cid', '{}', time, 1);
	}
	function prepare(sql: string, params: SQLInputValue[] = []): Statement {
		return {
			bind: (...values: unknown[]) => prepare(sql, values as SQLInputValue[]),
			all: async <T>() => ({ results: sqlite.prepare(sql).all(...params) as T[] }),
			first: async <T>() => (sqlite.prepare(sql).get(...params) as T) ?? null,
			run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...params).changes) } })
		};
	}
	const db: Database = {
		prepare,
		batch: async (statements) => Promise.all(statements.map((statement) => statement.run())),
		dialect: sqliteDialect
	};
	return { sqlite, db };
}

/** One page of rsvp.atmo.declaration.listDeclared, as contrail serves it. */
async function listDeclared(db: Database, cursor?: string) {
	const resolved = resolveConfig(config);
	const source = await config.collections.declaration.pipelineQueries!.listDeclared(
		db,
		new URLSearchParams(),
		resolved
	);
	return queryRecords(db, resolved, { collection: 'declaration', source, limit: 100, cursor });
}

describe('rsvp.atmo.declaration.listDeclared', () => {
	it('lists only the declaration at rkey self, so an account counts once, newest first', async () => {
		const { sqlite, db } = setup([
			['did:plc:old', 'self', 100],
			['did:plc:flood', 'self', 200],
			['did:plc:flood', 'extra1', 300],
			['did:plc:flood', 'extra2', 400],
			['did:plc:other', 'not-self', 500]
		]);
		try {
			const page = await listDeclared(db);
			expect(page.records.map((record) => record.uri)).toEqual([
				`at://did:plc:flood/${COLLECTION}/self`,
				`at://did:plc:old/${COLLECTION}/self`
			]);
		} finally {
			sqlite.close();
		}
	});

	it('pages past 100', async () => {
		const declarations = Array.from({ length: 101 }, (_, i): [string, string, number] => [
			`did:plc:g${String(i).padStart(3, '0')}`,
			'self',
			i
		]);
		const { sqlite, db } = setup(declarations);
		try {
			const first = await listDeclared(db);
			expect(first.records).toHaveLength(100);
			expect(first.cursor).toBeTruthy();
			const second = await listDeclared(db, first.cursor);
			expect(second.records.map((record) => record.did)).toEqual(['did:plc:g000']);
			expect(second.cursor).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});
});

import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
	queryRecords,
	resolveConfig,
	sqliteDialect,
	type Database,
	type Statement
} from '@atmo-dev/contrail';
import { servedConfig } from '../contrail.config';
import {
	cachedHandles,
	crowdedServers,
	DECLARED_PER_SERVER,
	type DeclaredHome
} from '../groups/server/declared';

const COLLECTION = 'org.atgrp.declaration';
const HOME = 'https://home.example';

/** A declaration as [did, rkey, time_us, the account's PDS (null: not resolved yet)]. */
type Declaration = [string, string, number, string | null];

/** contrail's declaration, identity and moderation tables in memory. */
function setup(declarations: Declaration[], hidden: string[] = []) {
	const sqlite = new DatabaseSync(':memory:');
	sqlite.exec(`CREATE TABLE records_declaration (
		uri TEXT PRIMARY KEY, did TEXT, rkey TEXT, cid TEXT, record TEXT,
		time_us INTEGER, indexed_at INTEGER
	);
	CREATE TABLE identities (did TEXT PRIMARY KEY, handle TEXT, pds TEXT, resolved_at INTEGER);
	CREATE TABLE moderation_hidden (subject TEXT, cid TEXT, starts_at INTEGER, exp INTEGER)`);
	const record = sqlite.prepare('INSERT INTO records_declaration VALUES (?, ?, ?, ?, ?, ?, ?)');
	const identity = sqlite.prepare('INSERT OR IGNORE INTO identities VALUES (?, NULL, ?, 1)');
	for (const [did, rkey, time, pds] of declarations) {
		record.run(`at://${did}/${COLLECTION}/${rkey}`, did, rkey, 'cid', '{}', time, 1);
		if (pds) identity.run(did, pds);
	}
	for (const did of hidden) {
		sqlite.prepare("INSERT INTO moderation_hidden VALUES (?, '', NULL, NULL)").run(did);
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

/** One page of rsvp.atmo.declaration.listDeclared, as contrail serves it, for a Worker whose group
 *  host is `home`. */
async function listDeclared(
	db: Database,
	query: Record<string, string> = {},
	{ cursor, home = null }: { cursor?: string; home?: DeclaredHome | null } = {}
) {
	const served = servedConfig(true, async () => home);
	const resolved = resolveConfig(served);
	const source = await served.collections.declaration.pipelineQueries!.listDeclared(
		db,
		new URLSearchParams(query),
		resolved
	);
	return queryRecords(db, resolved, { collection: 'declaration', source, limit: 100, cursor });
}

/** `count` groups at `pds`, newest first by index, named <prefix>00, <prefix>01, … */
function groupsAt(pds: string | null, prefix: string, count: number, newest = 1000): Declaration[] {
	return Array.from({ length: count }, (_, i): Declaration => [
		`did:plc:${prefix}${String(i).padStart(3, '0')}`,
		'self',
		newest - i,
		pds
	]);
}

const dids = (page: { records: { did: string }[] }) => page.records.map((record) => record.did);

/** HOME as the Worker names it, holding `declarations`; null when it does not say what it holds. */
const home = (declarations: Declaration[] | null): DeclaredHome => ({
	origin: HOME,
	held: async () => declarations && declarations.map(([did]) => did)
});

describe('rsvp.atmo.declaration.listDeclared', () => {
	it("lists one server's groups without reading every account contrail knows", async () => {
		const { sqlite, db } = setup(groupsAt('https://a.example', 'a', 3));
		try {
			const ran: { sql: string; params: SQLInputValue[] }[] = [];
			const spy: Database = {
				...db,
				prepare(sql: string) {
					const statement = (params: SQLInputValue[]): Statement => ({
						bind: (...values: unknown[]) => statement(values as SQLInputValue[]),
						all: async <T>() => {
							ran.push({ sql, params });
							return db
								.prepare(sql)
								.bind(...params)
								.all<T>();
						},
						first: async <T>() =>
							db
								.prepare(sql)
								.bind(...params)
								.first<T>(),
						run: async () =>
							db
								.prepare(sql)
								.bind(...params)
								.run()
					});
					return statement([]);
				}
			};
			expect(dids(await listDeclared(spy, { server: 'https://a.example' }))).toHaveLength(3);
			const plan = ran.flatMap(({ sql, params }) =>
				(sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(
					(row) => row.detail
				)
			);
			expect(plan.filter((detail) => /^SCAN i\b/.test(detail))).toEqual([]);
			expect(plan.some((detail) => /^SEARCH i (EXISTS )?USING .*\(did=\?\)/.test(detail))).toBe(
				true
			);
		} finally {
			sqlite.close();
		}
	});

	it('lists only the declaration at rkey self, so an account counts once, newest first', async () => {
		const { sqlite, db } = setup([
			['did:plc:old', 'self', 100, 'https://a.example'],
			['did:plc:flood', 'self', 200, 'https://a.example'],
			['did:plc:flood', 'extra1', 300, 'https://a.example'],
			['did:plc:flood', 'extra2', 400, 'https://a.example'],
			['did:plc:other', 'not-self', 500, 'https://a.example']
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

	it("gives each server at most 20 places, for its newest groups, and the home server's all", async () => {
		const atHome = groupsAt(HOME, 'h', 25, 1000);
		const { sqlite, db } = setup([
			...groupsAt('https://flood.example', 'f', 25, 2000),
			...groupsAt('https://small.example/', 's', 2, 1500),
			...atHome
		]);
		try {
			const page = dids(await listDeclared(db, {}, { home: home(atHome) }));
			const flood = page.filter((did) => did.startsWith('did:plc:f'));
			expect(flood).toEqual(groupsAt(null, 'f', DECLARED_PER_SERVER).map(([did]) => did));
			// The trailing slash in a DID document's address is the same server.
			expect(page.filter((did) => did.startsWith('did:plc:s'))).toHaveLength(2);
			expect(page.filter((did) => did.startsWith('did:plc:h'))).toHaveLength(25);
			// Without a home, the home server is limited too.
			const capped = dids(await listDeclared(db));
			expect(capped.filter((did) => did.startsWith('did:plc:h'))).toHaveLength(20);
		} finally {
			sqlite.close();
		}
	});

	it('leaves out a group that only names the home server, and limits home without proof', async () => {
		const atHome = groupsAt(HOME, 'h', 3, 1000);
		// Their DID documents name home, but home does not hold them.
		const fakes = groupsAt(HOME, 'x', 30, 2000);
		const { sqlite, db } = setup([...atHome, ...fakes]);
		try {
			const page = dids(await listDeclared(db, {}, { home: home(atHome) }));
			expect(page).toEqual(atHome.map(([did]) => did));
			// Without what home holds, home gets 20 places.
			expect(dids(await listDeclared(db, {}, { home: home(null) }))).toHaveLength(
				DECLARED_PER_SERVER
			);
		} finally {
			sqlite.close();
		}
	});

	it("lists only what home holds on home's own page", async () => {
		const atHome = groupsAt(HOME, 'h', 2, 1000);
		const { sqlite, db } = setup([...atHome, ...groupsAt(HOME, 'x', 2, 2000)]);
		try {
			const page = await listDeclared(db, { server: HOME }, { home: home(atHome) });
			expect(dids(page)).toEqual(atHome.map(([did]) => did));
			expect(dids(await listDeclared(db, { server: HOME }))).toHaveLength(4);
		} finally {
			sqlite.close();
		}
	});

	it('takes the home server and what it holds from the Worker, never from a caller', async () => {
		const atHome = groupsAt(HOME, 'h', 25, 1000);
		const { sqlite, db } = setup([...atHome, ...groupsAt(HOME, 'x', 2, 2000)]);
		try {
			const named = { home: HOME, held: JSON.stringify(atHome.map(([did]) => did)) };
			expect(dids(await listDeclared(db, named))).toHaveLength(DECLARED_PER_SERVER);
			expect(dids(await listDeclared(db, { ...named, server: HOME }))).toHaveLength(27);
			// A caller who names another server as home changes nothing either.
			const other = { home: 'https://x.example', held: '["did:plc:x000"]' };
			const asWorker = dids(await listDeclared(db, {}, { home: home(atHome) }));
			expect(dids(await listDeclared(db, other, { home: home(atHome) }))).toEqual(asWorker);
			expect(asWorker).toHaveLength(25);
		} finally {
			sqlite.close();
		}
	});

	it('lists every group at one server, and nothing else, for its own page', async () => {
		const { sqlite, db } = setup([
			...groupsAt('https://flood.example', 'f', 25),
			...groupsAt('https://small.example', 's', 2)
		]);
		try {
			const page = dids(await listDeclared(db, { server: 'https://flood.example' }));
			expect(page).toEqual(groupsAt(null, 'f', 25).map(([did]) => did));
			// Only an exact origin names a server.
			const loose = dids(await listDeclared(db, { server: 'https://flood.example/' }));
			expect(loose).toHaveLength(DECLARED_PER_SERVER + 2);
		} finally {
			sqlite.close();
		}
	});

	it("leaves out what moderation hides, so hidden groups take no server's places", async () => {
		const declarations = groupsAt('https://a.example', 'a', 21);
		const { sqlite, db } = setup(declarations, [declarations[0][0]]);
		try {
			const page = dids(await listDeclared(db));
			expect(page).toEqual(declarations.slice(1).map(([did]) => did));
			expect(await crowdedServers(db, null)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('counts accounts not resolved yet as one server', async () => {
		const { sqlite, db } = setup(groupsAt(null, 'u', 25));
		try {
			expect(dids(await listDeclared(db))).toHaveLength(DECLARED_PER_SERVER);
			expect(await crowdedServers(db, null)).toEqual([]);
		} finally {
			sqlite.close();
		}
	});

	it('pages past 100', async () => {
		const atHome = groupsAt(HOME, 'g', 101);
		const { sqlite, db } = setup(atHome);
		try {
			const first = await listDeclared(db, {}, { home: home(atHome) });
			expect(first.records).toHaveLength(100);
			expect(first.cursor).toBeTruthy();
			const second = await listDeclared(db, {}, { cursor: first.cursor, home: home(atHome) });
			expect(dids(second)).toEqual(['did:plc:g100']);
			expect(second.cursor).toBeUndefined();
		} finally {
			sqlite.close();
		}
	});
});

describe('crowdedServers', () => {
	it('names the servers with more groups than the list shows, most left out first', async () => {
		const { sqlite, db } = setup([
			...groupsAt('https://flood.example', 'f', 30),
			...groupsAt('https://busy.example', 'b', 22),
			...groupsAt('https://small.example', 's', 20),
			...groupsAt(HOME, 'h', 40)
		]);
		try {
			expect(await crowdedServers(db, HOME)).toEqual([
				{ server: 'https://flood.example', more: 10 },
				{ server: 'https://busy.example', more: 2 }
			]);
			expect((await crowdedServers(db, null)).map((s) => s.server)).toContain(HOME);
		} finally {
			sqlite.close();
		}
	});
});

describe('cachedHandles', () => {
	it('reads the handles contrail holds, leaving out unknown accounts and failed checks', async () => {
		const { sqlite, db } = setup([
			['did:plc:knit', 'self', 3, 'https://pds.example'],
			['did:plc:invalid', 'self', 2, 'https://pds.example'],
			['did:plc:unresolved', 'self', 1, 'https://pds.example']
		]);
		const handle = sqlite.prepare('UPDATE identities SET handle = ? WHERE did = ?');
		handle.run('knit.example', 'did:plc:knit');
		handle.run('handle.invalid', 'did:plc:invalid');
		expect(
			await cachedHandles(db, [
				'did:plc:knit',
				'did:plc:invalid',
				'did:plc:unresolved',
				'did:plc:nobody'
			])
		).toEqual(new Map([['did:plc:knit', 'knit.example']]));
		expect(await cachedHandles(db, [])).toEqual(new Map());
	});
});

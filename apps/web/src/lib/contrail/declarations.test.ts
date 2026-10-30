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
import { crowdedServers, DECLARED_PER_SERVER } from '../groups/server/declared';

const COLLECTION = 'group.opensocial.declaration';
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

/** One page of rsvp.atmo.declaration.listDeclared, as contrail serves it. */
async function listDeclared(db: Database, query: Record<string, string> = {}, cursor?: string) {
	const resolved = resolveConfig(config);
	const source = await config.collections.declaration.pipelineQueries!.listDeclared(
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

/** What `home` says it holds, as listDeclared takes it. */
const held = (declarations: Declaration[]) => JSON.stringify(declarations.map(([did]) => did));

describe('rsvp.atmo.declaration.listDeclared', () => {
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
			const page = dids(await listDeclared(db, { home: HOME, held: held(atHome) }));
			const flood = page.filter((did) => did.startsWith('did:plc:f'));
			expect(flood).toEqual(groupsAt(null, 'f', DECLARED_PER_SERVER).map(([did]) => did));
			// The trailing slash in a DID document's address is the same server.
			expect(page.filter((did) => did.startsWith('did:plc:s'))).toHaveLength(2);
			expect(page.filter((did) => did.startsWith('did:plc:h'))).toHaveLength(25);
			// Without `home`, the home server is limited too.
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
			const page = dids(await listDeclared(db, { home: HOME, held: held(atHome) }));
			expect(page).toEqual(atHome.map(([did]) => did));
			// Without what home holds, or with a held list that is not one, home gets 20 places.
			expect(dids(await listDeclared(db, { home: HOME }))).toHaveLength(DECLARED_PER_SERVER);
			const unreadable = await listDeclared(db, { home: HOME, held: 'did:plc:h000' });
			expect(dids(unreadable)).toHaveLength(DECLARED_PER_SERVER);
		} finally {
			sqlite.close();
		}
	});

	it("lists only what home holds on home's own page", async () => {
		const atHome = groupsAt(HOME, 'h', 2, 1000);
		const { sqlite, db } = setup([...atHome, ...groupsAt(HOME, 'x', 2, 2000)]);
		try {
			const page = await listDeclared(db, { server: HOME, home: HOME, held: held(atHome) });
			expect(dids(page)).toEqual(atHome.map(([did]) => did));
			expect(dids(await listDeclared(db, { server: HOME }))).toHaveLength(4);
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
			const query = { home: HOME, held: held(atHome) };
			const first = await listDeclared(db, query);
			expect(first.records).toHaveLength(100);
			expect(first.cursor).toBeTruthy();
			const second = await listDeclared(db, query, first.cursor);
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

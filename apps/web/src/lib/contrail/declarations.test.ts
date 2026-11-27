// The groups list's reads, against contrail's own tables and indexes as it makes them, so the
// query plans checked here are the ones the Worker's database would use.
import { describe, expect, it } from 'vitest';
import { Contrail, queryRecords, resolveConfig, type Database } from '@atmo-dev/contrail';
import { createSqliteDatabase } from '@atmo-dev/contrail/sqlite';
import { servedConfig } from '../contrail.config';
import {
	cachedProfiles,
	cacheProfile,
	DECLARED_PAGE,
	ensureGroupSchema,
	groupLabels,
	groupServers,
	UPCOMING_PAGE,
	UPCOMING_PER_SERVER,
	upcomingGroups
} from '../groups/server/declared';

const DECLARATION = 'org.atgrp.declaration';
const EVENT = 'community.lexicon.calendar.event';
const NOW = '2030-06-01T12:00:00.000Z';

/** `minutes` from NOW. */
const at = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();

async function setup(): Promise<Database> {
	const db = createSqliteDatabase(':memory:');
	await new Contrail(servedConfig(true)).init(db);
	await ensureGroupSchema(db);
	return db;
}

const run = (db: Database, sql: string, ...values: unknown[]) =>
	db
		.prepare(sql)
		.bind(...values)
		.run();

/** A declared group at `pds` (null: not resolved yet), with its declaration indexed at `time`. */
async function declare(
	db: Database,
	did: string,
	{
		pds = 'https://a.example',
		handle = null,
		time = 1,
		rkey = 'self'
	}: { pds?: string | null; handle?: string | null; time?: number; rkey?: string } = {}
) {
	await run(
		db,
		`INSERT INTO records_declaration (uri, did, rkey, cid, record, time_us, indexed_at)
		VALUES (?, ?, ?, 'cid', '{}', ?, 1)`,
		`at://${did}/${DECLARATION}/${rkey}`,
		did,
		rkey,
		time
	);
	if (pds) {
		await run(
			db,
			'INSERT OR IGNORE INTO identities (did, handle, pds, resolved_at) VALUES (?, ?, ?, 1)',
			did,
			handle,
			pds
		);
	}
}

/** A public event in `did`'s repo. */
async function event(
	db: Database,
	did: string,
	rkey: string,
	startsAt: string,
	record: Record<string, unknown> = {}
) {
	await run(
		db,
		`INSERT INTO records_event (uri, did, rkey, cid, record, time_us, indexed_at)
		VALUES (?, ?, ?, 'cid', ?, 1, 1)`,
		`at://${did}/${EVENT}/${rkey}`,
		did,
		rkey,
		JSON.stringify({ name: `${rkey} event`, startsAt, ...record })
	);
}

const hide = (db: Database, subject: string) =>
	run(db, "INSERT INTO moderation_hidden (subject, kind) VALUES (?, 'takedown')", subject);

/** `count` declared groups at `pds`, each with one event, the first at `from` minutes and each
 *  next a minute later: <prefix>000, <prefix>001, … */
async function groupsAt(db: Database, pds: string, prefix: string, count: number, from: number) {
	const dids: string[] = [];
	for (let i = 0; i < count; i++) {
		const did = `did:plc:${prefix}${String(i).padStart(3, '0')}`;
		await declare(db, did, { pds });
		await event(db, did, 'e', at(from + i));
		dids.push(did);
	}
	return dids;
}

/** The statements `db` runs, with the plan SQLite makes for each. */
function planned(db: Database) {
	const plans: string[][] = [];
	const spy: Database = {
		...db,
		prepare(sql: string) {
			const statement = (values: unknown[]) => ({
				bind: (...next: unknown[]) => statement(next),
				all: async <T>() => {
					const plan = await db
						.prepare(`EXPLAIN QUERY PLAN ${sql}`)
						.bind(...values)
						.all<{ detail: string }>();
					plans.push((plan.results ?? []).map((row) => row.detail));
					return db
						.prepare(sql)
						.bind(...values)
						.all<T>();
				},
				first: <T>() =>
					db
						.prepare(sql)
						.bind(...values)
						.first<T>(),
				run: () =>
					db
						.prepare(sql)
						.bind(...values)
						.run()
			});
			return statement([]) as ReturnType<Database['prepare']>;
		}
	};
	return { spy, plans };
}

async function allPages(db: Database) {
	const pages: string[][] = [];
	let cursor: string | null = null;
	do {
		const page = await upcomingGroups(db, NOW, cursor);
		pages.push(page.groups.map((group) => group.did));
		cursor = page.cursor;
	} while (cursor && pages.length < 20);
	return pages;
}

describe('the groups with an event coming', () => {
	it('lists them by their next event, soonest first, named by cached name or handle', async () => {
		const db = await setup();
		await declare(db, 'did:plc:later', { handle: 'later.example' });
		await event(db, 'did:plc:later', 'past', at(-60));
		await event(db, 'did:plc:later', 'far', at(600));
		await event(db, 'did:plc:later', 'next', at(30));
		await declare(db, 'did:plc:soon', { pds: 'https://b.example', handle: 'handle.invalid' });
		await event(db, 'did:plc:soon', 'one', at(5));
		await cacheProfile(db, 'did:plc:soon', { name: 'Riders', description: null, handle: null });
		await declare(db, 'did:plc:unresolved', { pds: null });
		await event(db, 'did:plc:unresolved', 'one', at(10));

		const page = await upcomingGroups(db, NOW);
		expect(page.groups).toEqual([
			{
				did: 'did:plc:soon',
				server: 'https://b.example',
				handle: null,
				name: 'Riders',
				next: { uri: `at://did:plc:soon/${EVENT}/one`, title: 'one event', startsAt: at(5) }
			},
			{
				did: 'did:plc:unresolved',
				server: '',
				handle: null,
				name: null,
				next: {
					uri: `at://did:plc:unresolved/${EVENT}/one`,
					title: 'one event',
					startsAt: at(10)
				}
			},
			{
				did: 'did:plc:later',
				server: 'https://a.example',
				handle: 'later.example',
				name: null,
				next: { uri: `at://did:plc:later/${EVENT}/next`, title: 'next event', startsAt: at(30) }
			}
		]);
		expect(page.cursor).toBeNull();
	});

	it('leaves out groups with only past events, hidden ones, and events the list does not count', async () => {
		const db = await setup();
		await declare(db, 'did:plc:past');
		await event(db, 'did:plc:past', 'gone', at(-1));
		await declare(db, 'did:plc:hidden');
		await event(db, 'did:plc:hidden', 'e', at(1));
		await hide(db, 'did:plc:hidden');
		await declare(db, 'did:plc:unlisted');
		await event(db, 'did:plc:unlisted', 'e', at(1), { preferences: { showInDiscovery: false } });
		await declare(db, 'did:plc:talks');
		await event(db, 'did:plc:talks', 'e', at(1), {
			additionalData: { parentEvent: { uri: `at://did:plc:conf/${EVENT}/c` } }
		});
		await declare(db, 'did:plc:other-key', { rkey: 'other' });
		await event(db, 'did:plc:other-key', 'e', at(1));
		// Not declared: an account with an event is not a group.
		await event(db, 'did:plc:person', 'e', at(1));
		// Its soonest event is hidden, so its next one is the one after.
		await declare(db, 'did:plc:moderated');
		await event(db, 'did:plc:moderated', 'taken-down', at(2));
		await event(db, 'did:plc:moderated', 'kept', at(3));
		await hide(db, `at://did:plc:moderated/${EVENT}/taken-down`);

		const page = await upcomingGroups(db, NOW);
		expect(page.groups.map((group) => [group.did, group.next.title])).toEqual([
			['did:plc:moderated', 'kept event']
		]);
		expect(await groupServers(db, NOW)).toEqual([
			{ server: 'https://a.example', groups: 4, upcoming: 1 }
		]);
	});

	it(`fills a page of ${UPCOMING_PAGE} with at most ${UPCOMING_PER_SERVER} of one server's`, async () => {
		const db = await setup();
		const busy = await groupsAt(db, 'https://busy.example', 'b', 20, 1);
		const other = await groupsAt(db, 'https://other.example', 'o', 20, 100);

		const pages = await allPages(db);
		// Every server's first turn of 15, by their next event, then their second.
		expect(pages).toEqual([
			[...busy.slice(0, 15), ...other.slice(0, 15)],
			[...busy.slice(15), ...other.slice(15)]
		]);
	});

	it("ends a page before a server's groups pass the limit, and pages through the rest", async () => {
		const db = await setup();
		const busy = await groupsAt(db, 'https://busy.example', 'b', 40, 1);
		const quiet = await groupsAt(db, 'https://quiet.example', 'q', 3, 500);

		const pages = await allPages(db);
		expect(pages).toEqual([[...busy.slice(0, 15), ...quiet], busy.slice(15, 30), busy.slice(30)]);
	});

	it('finds each next event in one step of an index, and reads only the declarations whole', async () => {
		const db = await setup();
		await groupsAt(db, 'https://a.example', 'a', 3, 1);
		const { spy, plans } = planned(db);
		await upcomingGroups(spy, NOW);
		await groupServers(spy, NOW);
		expect(plans).toHaveLength(2);
		for (const plan of plans) {
			expect(plan).toContain('SEARCH e USING INDEX groups_event_did_starts (did=? AND <expr>>?)');
			// Once each: the next event is looked up once per group.
			expect(plan.filter((step) => step.startsWith('SCAN d'))).toEqual(['SCAN d']);
			expect(plan.filter((step) => /^SEARCH e USING INDEX groups_/.test(step))).toHaveLength(1);
			// Events, identities, moderation and profiles only by key.
			expect(plan.filter((step) => /^SCAN (e|i|mh|p)\b/.test(step))).toEqual([]);
		}
	});
});

describe('the servers with declared groups', () => {
	it('counts each server’s declared groups and those with an event coming, busiest first', async () => {
		const db = await setup();
		await groupsAt(db, 'https://busy.example', 'b', 3, 1);
		await declare(db, 'did:plc:quiet-b', { pds: 'https://busy.example/' });
		await declare(db, 'did:plc:quiet-c', { pds: 'https://many.example' });
		await declare(db, 'did:plc:quiet-d', { pds: 'https://many.example' });
		await declare(db, 'did:plc:quiet-e', { pds: 'https://many.example' });
		await groupsAt(db, 'https://few.example', 'f', 1, 1);
		await declare(db, 'did:plc:unresolved', { pds: null });
		await declare(db, 'did:plc:hidden', { pds: 'https://hidden.example' });
		await hide(db, 'did:plc:hidden');
		expect(await groupServers(db, NOW)).toEqual([
			{ server: 'https://busy.example', groups: 4, upcoming: 3 },
			{ server: 'https://few.example', groups: 1, upcoming: 1 },
			{ server: 'https://many.example', groups: 3, upcoming: 0 }
		]);
	});
});

/** One page of rsvp.atmo.declaration.listDeclared, as contrail serves it. */
async function listDeclared(db: Database, query: Record<string, string> = {}, cursor?: string) {
	const served = servedConfig(true);
	const resolved = resolveConfig(served);
	const source = await served.collections.declaration.pipelineQueries!.listDeclared(
		db,
		new URLSearchParams(query),
		resolved
	);
	return queryRecords(db, resolved, {
		collection: 'declaration',
		source,
		limit: DECLARED_PAGE,
		cursor
	});
}

const dids = (page: { records: { did: string }[] }) => page.records.map((record) => record.did);

describe('rsvp.atmo.declaration.listDeclared', () => {
	it('lists only the declaration at rkey self, so an account counts once, newest first', async () => {
		const db = await setup();
		await declare(db, 'did:plc:old', { time: 100 });
		await declare(db, 'did:plc:flood', { time: 200 });
		await declare(db, 'did:plc:flood', { time: 300, rkey: 'extra' });
		await declare(db, 'did:plc:other', { time: 500, rkey: 'not-self' });
		expect(dids(await listDeclared(db))).toEqual(['did:plc:flood', 'did:plc:old']);
	});

	it(`lists every group at one server, ${DECLARED_PAGE} a page, with or without an event coming`, async () => {
		const db = await setup();
		for (let i = 0; i < 60; i++) {
			await declare(db, `did:plc:f${String(i).padStart(3, '0')}`, {
				pds: 'https://flood.example',
				time: 1000 - i
			});
		}
		await declare(db, 'did:plc:elsewhere', { pds: 'https://small.example', time: 5000 });
		const first = await listDeclared(db, { server: 'https://flood.example' });
		expect(first.records).toHaveLength(DECLARED_PAGE);
		const second = await listDeclared(db, { server: 'https://flood.example' }, first.cursor);
		expect(dids(second)).toHaveLength(10);
		expect(second.cursor).toBeUndefined();
		expect(new Set([...dids(first), ...dids(second)]).has('did:plc:elsewhere')).toBe(false);
		// Only an exact origin names a server.
		const loose = await listDeclared(db, { server: 'https://flood.example/' });
		expect(dids(loose)).toContain('did:plc:elsewhere');
	});

	it("lists one server's groups without reading every account contrail knows", async () => {
		const db = await setup();
		await declare(db, 'did:plc:a', { pds: 'https://a.example' });
		const { spy, plans } = planned(db);
		expect(dids(await listDeclared(spy, { server: 'https://a.example' }))).toEqual(['did:plc:a']);
		const steps = plans.flat();
		expect(steps.filter((step) => /^SCAN i\b/.test(step))).toEqual([]);
		expect(steps.some((step) => /^SEARCH i (EXISTS )?USING .*\(did=\?\)/.test(step))).toBe(true);
	});

	it('finds groups by handle or by cached name, in any case, at one server or all', async () => {
		const db = await setup();
		await declare(db, 'did:plc:knit', { handle: 'knitters.groups.example', time: 3 });
		await declare(db, 'did:plc:named', { handle: 'g1.groups.example', time: 2 });
		await cacheProfile(db, 'did:plc:named', {
			name: 'Night Knit',
			description: null,
			handle: null
		});
		await declare(db, 'did:plc:far', {
			pds: 'https://far.example',
			handle: 'knit.far.example',
			time: 1
		});
		await declare(db, 'did:plc:other', { handle: 'riders.groups.example' });
		await declare(db, 'did:plc:invalid', { handle: 'handle.invalid' });

		expect(dids(await listDeclared(db, { q: 'KNIT' }))).toEqual([
			'did:plc:knit',
			'did:plc:named',
			'did:plc:far'
		]);
		expect(dids(await listDeclared(db, { q: '@night' }))).toEqual(['did:plc:named']);
		expect(dids(await listDeclared(db, { q: 'knit', server: 'https://a.example' }))).toEqual([
			'did:plc:knit',
			'did:plc:named'
		]);
		expect(dids(await listDeclared(db, { q: 'invalid' }))).toEqual([]);
		// LIKE's wildcards are only themselves.
		expect(dids(await listDeclared(db, { q: '%' }))).toEqual([]);
		expect(dids(await listDeclared(db, { q: 'g_.groups' }))).toEqual([]);
	});

	it('finds no group that is hidden or not declared, whatever its cached name', async () => {
		const db = await setup();
		await declare(db, 'did:plc:hidden', { handle: 'knit-hidden.example' });
		await hide(db, 'did:plc:hidden');
		// A cached profile of a group whose declaration is gone: unlisted, or private now.
		await cacheProfile(db, 'did:plc:unlisted', {
			name: 'Knitters',
			description: null,
			handle: null
		});
		await run(
			db,
			"INSERT INTO identities (did, handle, pds, resolved_at) VALUES ('did:plc:unlisted', 'knit.example', 'https://a.example', 1)"
		);
		expect(dids(await listDeclared(db, { q: 'knit' }))).toEqual([]);
	});
});

describe('what a list shows of a group', () => {
	it('names it by its cached profile, with the handle contrail holds, or the cached one', async () => {
		const db = await setup();
		await declare(db, 'did:plc:a', { handle: 'a.example' });
		await cacheProfile(db, 'did:plc:a', {
			name: 'A',
			description: 'About A',
			handle: 'old.example'
		});
		await declare(db, 'did:plc:invalid', { handle: 'handle.invalid' });
		await cacheProfile(db, 'did:plc:invalid', {
			name: 'I',
			description: null,
			handle: 'i.example'
		});
		await declare(db, 'did:plc:bare', { handle: null });
		expect(await groupLabels(db, ['did:plc:a', 'did:plc:invalid', 'did:plc:bare'])).toEqual(
			new Map([
				['did:plc:a', { handle: 'a.example', name: 'A', description: 'About A' }],
				['did:plc:invalid', { handle: 'i.example', name: 'I', description: null }],
				['did:plc:bare', { handle: null, name: null, description: null }]
			])
		);
	});

	it('keeps a cached profile, writes nothing for the same one again, and removes it', async () => {
		const db = await setup();
		const changes = async () =>
			(await db.prepare('SELECT total_changes() AS n').first<{ n: number }>())!.n;
		const knitters = { name: 'Knitters', description: 'Yarn', handle: 'knit.example' };
		await cacheProfile(db, 'did:plc:g', knitters);
		const written = await changes();
		await cacheProfile(db, 'did:plc:g', { ...knitters });
		expect(await changes()).toBe(written);
		await cacheProfile(db, 'did:plc:g', { ...knitters, name: 'Purl' });
		expect((await cachedProfiles(db, ['did:plc:g', 'did:plc:none'])).get('did:plc:g')).toEqual({
			...knitters,
			name: 'Purl'
		});
		await cacheProfile(db, 'did:plc:g', null);
		expect(await cachedProfiles(db, ['did:plc:g'])).toEqual(new Map());
	});

	it("keeps a cached profile's website, and adds its column to a table made before it", async () => {
		const db = createSqliteDatabase(':memory:');
		await new Contrail(servedConfig(true)).init(db);
		await run(
			db,
			'CREATE TABLE group_profiles (did TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, handle TEXT)'
		);
		await run(db, "INSERT INTO group_profiles VALUES ('did:plc:old', 'Old', NULL, NULL)");
		await ensureGroupSchema(db);
		const knitters = { name: 'Knitters', description: null, handle: null };
		await cacheProfile(db, 'did:plc:g', { ...knitters, website: 'https://knit.example/' });
		const cached = await cachedProfiles(db, ['did:plc:g', 'did:plc:old']);
		expect(cached.get('did:plc:g')).toEqual({ ...knitters, website: 'https://knit.example/' });
		expect(cached.get('did:plc:old')).toEqual({ name: 'Old', description: null, handle: null });
		// Its website taken away is a change too.
		await cacheProfile(db, 'did:plc:g', knitters);
		expect((await cachedProfiles(db, ['did:plc:g'])).get('did:plc:g')).toEqual(knitters);
	});
});

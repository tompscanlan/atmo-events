// What the groups list reads from the index, and the one table groups add to it. A group is listed
// when the index holds its declaration at rkey self and moderation leaves it visible. Its server is
// the PDS address in the account's DID document, as contrail resolved it when it indexed the
// account's records. A DID document can name any server, so a server's groups are the groups that
// name it.
//
// The default list is of groups with an upcoming event, soonest first. Any account can declare
// itself a group, so one server could fill that list: a page holds at most UPCOMING_PER_SERVER of
// any server's, and the rest of that server's follow on the next page, while other servers' groups
// fill the page. Every group, with an event coming or not, is on its server's own list and found by
// search.
import {
	recordsTableName,
	visibleRecordSql,
	type Database,
	type RecordSource
} from '@atmo-dev/contrail';
import { discoverableSql } from '../../contrail/discoverability';
import { hasParentEventSql } from '../../legacy-conference';

export const UPCOMING_PAGE = 30;
export const UPCOMING_PER_SERVER = 15;
/** A server's own list, and a search's. */
export const DECLARED_PAGE = 50;
/** The servers the list names, those with the most groups with an event coming first. */
export const SERVERS_SHOWN = 50;
/** A search's longest term. */
export const SEARCH_MAX = 64;

const DECLARATIONS = recordsTableName('declaration');
const EVENTS = recordsTableName('event');
const PROFILES = 'group_profiles';

/** The table groups add to the database, made when a group list or page first needs it, so only
 *  while groups are on: the profiles cached for visitors. Small, and made in one quick statement,
 *  so a request may make it. */
const PROFILES_TABLE = `CREATE TABLE IF NOT EXISTS ${PROFILES} (
		did TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		description TEXT,
		handle TEXT,
		website TEXT
	)`;

/** Columns added to the table after it was first made, for a database that made it before. */
const ADDED_COLUMNS = [{ name: 'website', type: 'TEXT' }];

const schemaReady = new WeakMap<object, Promise<void>>();

/** Once per database, after contrail has made its tables. A column is added only when the table
 *  lacks it. */
export function ensureGroupSchema(db: Database): Promise<void> {
	let ready = schemaReady.get(db);
	if (!ready) {
		ready = (async () => {
			await db.prepare(PROFILES_TABLE).run();
			const { results } = await db
				.prepare(`SELECT name FROM pragma_table_info('${PROFILES}')`)
				.all<{ name: string }>();
			const has = new Set((results ?? []).map((column) => column.name));
			for (const { name, type } of ADDED_COLUMNS.filter((column) => !has.has(column.name))) {
				await db
					.prepare(`ALTER TABLE ${PROFILES} ADD COLUMN ${name} ${type}`)
					.run()
					.catch((e: unknown) => {
						// Added by another request in between.
						if (!/duplicate column/i.test(e instanceof Error ? e.message : String(e))) throw e;
					});
			}
		})().catch((e) => {
			schemaReady.delete(db);
			throw e;
		});
		schemaReady.set(db, ready);
	}
	return ready;
}

/** The index that finds a group's next event without reading its past ones. It is built over
 *  contrail's events table, the largest there is, which can take longer than a visitor's request
 *  should wait, so only the scheduled job builds it (routes/api/cron), and only while groups are
 *  on. Until it is there the list answers the same, by contrail's own index on the events' DID,
 *  reading each group's past events too. */
export const GROUP_EVENT_INDEX = 'groups_event_did_starts';

const GROUP_EVENT_INDEX_SQL = `CREATE INDEX IF NOT EXISTS ${GROUP_EVENT_INDEX}
	ON ${EVENTS}(did, json_extract(record, '$.startsAt'))`;

const eventIndexBuilt = new WeakSet<object>();

/** Builds the index unless this isolate saw it built. Turning groups off again leaves it, as it
 *  leaves the profiles table and the declarations table: unread, but the index is still kept up
 *  to date on every write to the events table, a cost that stays until it is dropped by hand
 *  (`DROP INDEX groups_event_did_starts`). */
export async function ensureGroupEventIndex(db: Database): Promise<void> {
	if (eventIndexBuilt.has(db)) return;
	await db.prepare(GROUP_EVENT_INDEX_SQL).run();
	eventIndexBuilt.add(db);
}

/** Accounts contrail has not resolved yet count under '', so they share one server's places. */
const serverOf = (identity: string) => `COALESCE(RTRIM(LOWER(${identity}.pds), '/'), '')`;
/** A handle that failed its two-way check is no handle. */
const handleOf = (identity: string) =>
	`CASE WHEN ${identity}.handle IN ('', 'handle.invalid') THEN NULL ELSE ${identity}.handle END`;
const startsAt = (event: string) => `json_extract(${event}.record, '$.startsAt')`;

/** The visible declarations at rkey self, each with its account's identity as `i`. Built per
 *  request, since the moderation check inlines the time. */
function declared(columns: string): string {
	return `SELECT ${columns} FROM ${DECLARATIONS} d LEFT JOIN identities i ON i.did = d.did
		WHERE d.rkey = 'self' AND ${visibleRecordSql('d')}`;
}

/** How many of a group's events starting from now on the list looks through, at most, for one that
 *  counts. Those soonest to start are taken by the index alone, then checked: so a group whose next
 *  NEXT_EVENT_LOOKAHEAD events are all hidden from discovery, a conference's talks, or hidden by
 *  moderation counts as having no event coming until enough of them have started, however many
 *  more it has after. No group's future events, however many, are read past that on any view. */
export const NEXT_EVENT_LOOKAHEAD = 25;

/** The group's events that count as coming: public, starting from the bound parameter on, among the
 *  first NEXT_EVENT_LOOKAHEAD of them to start, shown in discovery, not a conference's talk, and
 *  left visible by moderation. */
function upcomingEvents(groupDid: string): string {
	return `FROM ${EVENTS} e WHERE e.uri IN (
			SELECT c.uri FROM ${EVENTS} c WHERE c.did = ${groupDid} AND ${startsAt('c')} >= ?
			ORDER BY ${startsAt('c')} LIMIT ${NEXT_EVENT_LOOKAHEAD}
		)
		AND ${discoverableSql('e.record')} AND NOT ${hasParentEventSql('e.record')}
		AND ${visibleRecordSql('e')}`;
}

/** An http(s) origin such as `https://pds.example`, exactly as URL writes it, or null. */
export function serverOrigin(value: string | null | undefined): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) && url.origin === value ? value : null;
	} catch {
		return null;
	}
}

/** What a search looks for: trimmed, without a leading @, at most SEARCH_MAX characters; null for
 *  nothing to look for. */
export function searchTerm(value: string | null | undefined): string | null {
	const term = (value ?? '').trim().replace(/^@/, '').slice(0, SEARCH_MAX).trim();
	return term || null;
}

/** Anywhere in the text, any case, with LIKE's own wildcards taken as themselves. */
const containing = (term: string) => `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** rsvp.atmo.declaration.listDeclared. Same shape as listRecords, but only the declaration at
 *  rkey `self`, so an account is listed once however many records it writes. `server` lists that
 *  server's groups; `q` the groups whose handle, or whose name as this site cached it, holds it. */
export async function declaredSource(db: Database, params: URLSearchParams): Promise<RecordSource> {
	const conditions = [`r.rkey = 'self'`];
	const values: string[] = [];
	const only = serverOrigin(params.get('server'));
	if (only) {
		// One key lookup per declaration: the server is an expression no index covers.
		conditions.push(
			`EXISTS (SELECT 1 FROM identities i WHERE i.did = r.did AND ${serverOf('i')} = ?)`
		);
		values.push(only);
	}
	const term = searchTerm(params.get('q'));
	if (term) {
		await ensureGroupSchema(db);
		conditions.push(`(EXISTS (SELECT 1 FROM identities i WHERE i.did = r.did
				AND i.handle <> 'handle.invalid' AND i.handle LIKE ? ESCAPE '\\')
			OR EXISTS (SELECT 1 FROM ${PROFILES} p WHERE p.did = r.did AND p.name LIKE ? ESCAPE '\\'))`);
		values.push(containing(term), containing(term));
	}
	return { conditions, params: values };
}

export interface UpcomingGroup {
	did: string;
	/** '' for an account contrail has not resolved yet. */
	server: string;
	handle: string | null;
	/** As this site cached it; null when it has none. */
	name: string | null;
	next: { uri: string; title: string; startsAt: string };
}

export interface UpcomingPage {
	groups: UpcomingGroup[];
	/** For the next page; null on the last. */
	cursor: string | null;
}

/** Where the next page starts: the time the first page was read at, which every later page reads
 *  at too, so an event that starts in between moves nothing; the last group shown, by its next
 *  event's start and its DID; and, for each server with groups left out of a page because it held
 *  UPCOMING_PER_SERVER of them already, the last of its groups shown. Each place is a group's own
 *  next event and DID, so a group or an event added in between moves no other group: one placed
 *  after these shows once, one placed before them not at all. A group not shown yet whose own next
 *  event is moved, or added, to before them in between is missed. */
interface Place {
	at: string;
	last: [startsAt: string, did: string];
	behind: Record<string, [startsAt: string, did: string]>;
}

const isKey = (value: unknown): value is [string, string] =>
	Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === 'string');

function placeCursor(place: Place): string {
	return btoa(JSON.stringify(place)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function parsePlace(cursor: string | null): Place | null {
	if (!cursor || cursor.length > 4096) return null;
	try {
		const place = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/'))) as Place;
		if (typeof place?.at !== 'string' || Number.isNaN(Date.parse(place.at))) return null;
		if (!isKey(place.last) || !place.behind || typeof place.behind !== 'object') return null;
		if (!Object.values(place.behind).every(isKey)) return null;
		return { at: place.at, last: place.last, behind: place.behind };
	} catch {
		return null;
	}
}

const after = (a: [string, string], b: [string, string]) =>
	a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/** One page of the groups with an event coming, by the start of their next one, soonest first,
 *  as of `now` on the first page and as of the first page's time on the pages after it. A page
 *  holds at most UPCOMING_PER_SERVER of one server's groups: a server's groups past those are
 *  left for the next page, which shows them first among those after the last group shown, and
 *  other servers' groups take the rest of the page meanwhile. One query: each group's next event
 *  is one step along groups_event_did_starts. */
export async function upcomingGroups(
	db: Database,
	now: string,
	cursor: string | null = null
): Promise<UpcomingPage> {
	const place = parsePlace(cursor);
	const at = place?.at ?? now;
	const last = place?.last ?? ['', ''];
	const behind = place?.behind ?? {};
	const { results } = await db
		.prepare(
			`WITH next AS MATERIALIZED (${declared(
				`d.did, ${serverOf('i')} AS server, ${handleOf('i')} AS handle,
				(SELECT e.uri ${upcomingEvents('d.did')} ORDER BY ${startsAt('e')}, e.uri LIMIT 1) AS uri`
			)}),
			placed AS (
				SELECT n.did, n.server, n.handle, n.uri,
					json_extract(e.record, '$.name') AS title, ${startsAt('e')} AS starts_at
				FROM next n JOIN ${EVENTS} e ON e.uri = n.uri
			),
			left_to_show AS (
				SELECT placed.*,
					ROW_NUMBER() OVER (PARTITION BY placed.server ORDER BY placed.starts_at, placed.did) AS rn
				FROM placed LEFT JOIN json_each(?) b ON b.key = placed.server
				WHERE (placed.starts_at, placed.did) > (
					COALESCE(json_extract(b.value, '$[0]'), ?), COALESCE(json_extract(b.value, '$[1]'), ?)
				)
			)
			SELECT left_to_show.*, p.name FROM left_to_show LEFT JOIN ${PROFILES} p ON p.did = left_to_show.did
			WHERE rn <= ${UPCOMING_PER_SERVER + 1}
			ORDER BY left_to_show.starts_at, left_to_show.did
			LIMIT ${UPCOMING_PAGE + 3}`
		)
		.bind(at, JSON.stringify(behind), last[0], last[1])
		.all<{
			did: string;
			server: string;
			handle: string | null;
			name: string | null;
			uri: string;
			title: unknown;
			starts_at: string;
		}>();
	const rows = results ?? [];
	const page: typeof rows = [];
	const shown = new Map<string, number>();
	/** The last of each server's groups shown on this page. */
	const lastOf = new Map<string, [string, string]>();
	/** Servers with groups left for the next page: at most two, since each showed a full share. */
	const full = new Set<string>();
	let more = false;
	for (const row of rows) {
		if (page.length === UPCOMING_PAGE) {
			more = true;
			break;
		}
		const count = shown.get(row.server) ?? 0;
		if (count === UPCOMING_PER_SERVER) {
			full.add(row.server);
			continue;
		}
		shown.set(row.server, count + 1);
		lastOf.set(row.server, [row.starts_at, row.did]);
		page.push(row);
	}
	more ||= full.size > 0;
	const end = page.at(-1);
	let next: string | null = null;
	if (more && end) {
		const pageEnd: [string, string] = [end.starts_at, end.did];
		const nextLast = after(pageEnd, last) ? pageEnd : last;
		const nextBehind: Place['behind'] = {};
		// A server left behind before stays so until a page reaches its place; one whose groups this
		// page left out waits at the last of its shown.
		for (const [server, key] of Object.entries(behind)) {
			const reached = after(pageEnd, key) ? pageEnd : key;
			if (after(nextLast, reached)) nextBehind[server] = reached;
		}
		for (const server of full) nextBehind[server] = lastOf.get(server)!;
		next = placeCursor({ at, last: nextLast, behind: nextBehind });
	}
	return {
		groups: page.map((row) => ({
			did: row.did,
			server: row.server,
			handle: row.handle,
			name: row.name,
			next: {
				uri: row.uri,
				title: typeof row.title === 'string' ? row.title : '',
				startsAt: row.starts_at
			}
		})),
		cursor: next
	};
}

export interface GroupServer {
	server: string;
	/** Its declared groups. */
	groups: number;
	/** Those of them with an event coming. */
	upcoming: number;
}

/** The servers with declared groups, those with the most groups with an event coming first, then
 *  the most groups. Counted with the same rules as the list, in one query. Accounts not resolved
 *  yet have no server page to send anyone to. */
export async function groupServers(
	db: Database,
	now: string,
	limit = SERVERS_SHOWN
): Promise<GroupServer[]> {
	const { results } = await db
		.prepare(
			`WITH servers AS MATERIALIZED (${declared(
				`${serverOf('i')} AS server, EXISTS (SELECT 1 ${upcomingEvents('d.did')}) AS upcoming`
			)})
			SELECT server, COUNT(*) AS groups, SUM(upcoming) AS upcoming FROM servers
			WHERE server <> ''
			GROUP BY server
			ORDER BY upcoming DESC, groups DESC, server
			LIMIT ?`
		)
		.bind(now, limit)
		.all<GroupServer>();
	return results ?? [];
}

export interface GroupLabel {
	/** As contrail holds it; else as it was when the profile was cached. */
	handle: string | null;
	name: string | null;
	description: string | null;
}

/** What a list shows of these groups, from the index's identities and the cached profiles, in one
 *  query and with no network call. contrail resolves each account whose records it indexes and
 *  takes handle changes from the relay. */
export async function groupLabels(db: Database, dids: string[]): Promise<Map<string, GroupLabel>> {
	const labels = new Map<string, GroupLabel>();
	if (dids.length === 0) return labels;
	const { results } = await db
		.prepare(
			`SELECT j.value AS did, ${handleOf('i')} AS handle, p.handle AS cached_handle,
				p.name, p.description
			FROM json_each(?) j
			LEFT JOIN identities i ON i.did = j.value
			LEFT JOIN ${PROFILES} p ON p.did = j.value`
		)
		.bind(JSON.stringify(dids))
		.all<{
			did: string;
			handle: string | null;
			cached_handle: string | null;
			name: string | null;
			description: string | null;
		}>();
	for (const row of results ?? []) {
		labels.set(row.did, {
			handle: row.handle ?? row.cached_handle,
			name: row.name,
			description: row.description
		});
	}
	return labels;
}

export interface StoredProfile {
	name: string;
	description: string | null;
	handle: string | null;
	/** Left out when the group has none. */
	website?: string;
}

export async function cachedProfiles(
	db: Database,
	dids: string[]
): Promise<Map<string, StoredProfile>> {
	const profiles = new Map<string, StoredProfile>();
	if (dids.length === 0) return profiles;
	const { results } = await db
		.prepare(
			`SELECT did, name, description, handle, website FROM ${PROFILES}
			WHERE did IN (SELECT value FROM json_each(?))`
		)
		.bind(JSON.stringify(dids))
		.all<Omit<StoredProfile, 'website'> & { did: string; website: string | null }>();
	for (const { did, website, ...profile } of results ?? []) {
		profiles.set(did, { ...profile, ...(website ? { website } : {}) });
	}
	return profiles;
}

/** Keeps `profile` for the group, or with null removes what was kept. A profile that is the same
 *  as the one kept writes nothing. */
export async function cacheProfile(
	db: Database,
	did: string,
	profile: StoredProfile | null
): Promise<void> {
	if (!profile) {
		await db.prepare(`DELETE FROM ${PROFILES} WHERE did = ?`).bind(did).run();
		return;
	}
	await db
		.prepare(
			`INSERT INTO ${PROFILES} (did, name, description, handle, website) VALUES (?, ?, ?, ?, ?)
			ON CONFLICT (did) DO UPDATE SET
				name = excluded.name, description = excluded.description, handle = excluded.handle,
				website = excluded.website
			WHERE name IS NOT excluded.name OR description IS NOT excluded.description
				OR handle IS NOT excluded.handle OR website IS NOT excluded.website`
		)
		.bind(did, profile.name, profile.description, profile.handle, profile.website ?? null)
		.run();
}

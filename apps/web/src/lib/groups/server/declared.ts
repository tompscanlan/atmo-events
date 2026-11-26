// Which declared groups the groups list shows. Any account can declare itself a group, so one
// server could fill the list with them: each server gets at most DECLARED_PER_SERVER places,
// for its newest groups, except this site's own group host. A server's other groups are listed
// on a page of their own. A server is the PDS address in the account's DID document, as
// contrail resolved it when it indexed the account's records. A DID document can name any
// server, and the relay checks it only when it first sees an account, so a group counts as at
// the group host only when the host says it holds it; one that only names the host is left out.
import {
	recordsTableName,
	visibleRecordSql,
	type Database,
	type RecordSource
} from '@atmo-dev/contrail';

export const DECLARED_PER_SERVER = 20;

const TABLE = recordsTableName('declaration');

/** Accounts contrail has not resolved yet count under '', so they share one server's places. */
const serverOf = (identity: string) => `COALESCE(RTRIM(LOWER(${identity}.pds), '/'), '')`;

/** The declarations at rkey self that moderation leaves visible, each with its server. Built
 *  per request, since the moderation check inlines the time. */
function visible(columns: string): string {
	return `SELECT ${columns} FROM ${TABLE} d LEFT JOIN identities i ON i.did = d.did
		WHERE d.rkey = 'self' AND ${visibleRecordSql('d')}`;
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

/** This site's own group host, whose groups the list does not limit: its origin, and the DIDs it
 *  says it holds, read only when a list needs them, and null when it did not say. Set by the
 *  Worker, never by a caller, so the public method cannot be told to treat another server so. */
export interface DeclaredHome {
	origin: string;
	held(): Promise<string[] | null>;
}

/** rsvp.atmo.declaration.listDeclared. With `server`, every group at that server. Otherwise each
 *  server's newest DECLARED_PER_SERVER, and every group `home` says it holds and none that only
 *  names it. A home that does not say what it holds is limited like any server. */
export async function declaredSource(
	params: URLSearchParams,
	home: DeclaredHome | null = null
): Promise<RecordSource> {
	const only = serverOrigin(params.get('server'));
	// Another server's page needs nothing from the host.
	const dids = home && (!only || only === home.origin) ? await home.held() : null;
	const held = home && dids ? { origin: home.origin, dids: JSON.stringify(dids) } : null;
	if (only) {
		const atHome = held !== null && only === held.origin;
		return {
			conditions: [
				`r.rkey = 'self'`,
				// One key lookup per declaration: the server is an expression no index covers.
				`EXISTS (SELECT 1 FROM identities i WHERE i.did = r.did AND ${serverOf('i')} = ?)`,
				...(atHome ? [`r.did IN (SELECT value FROM json_each(?))`] : [])
			],
			params: atHome ? [only, held.dids] : [only]
		};
	}
	const placed = visible(
		`d.uri, d.did, ${serverOf('i')} AS server, ROW_NUMBER() OVER (PARTITION BY ${serverOf('i')} ORDER BY d.time_us DESC, d.uri) AS place`
	);
	const keep = held
		? `CASE WHEN server = ? THEN did IN (SELECT value FROM json_each(?)) ELSE place <= ${DECLARED_PER_SERVER} END`
		: `place <= ${DECLARED_PER_SERVER}`;
	return {
		conditions: [`r.rkey = 'self'`, `r.uri IN (SELECT uri FROM (${placed}) placed WHERE ${keep})`],
		params: held ? [held.origin, held.dids] : []
	};
}

/** The handles contrail holds for these accounts, read from its identities table with no network
 *  call. contrail resolves each account whose records it indexes and takes handle changes from the
 *  relay; a handle that failed its two-way check is left out. */
export async function cachedHandles(db: Database, dids: string[]): Promise<Map<string, string>> {
	const handles = new Map<string, string>();
	if (dids.length === 0) return handles;
	const { results } = await db
		.prepare(
			`SELECT did, handle FROM identities
			WHERE did IN (SELECT value FROM json_each(?))
				AND handle IS NOT NULL AND handle <> '' AND handle <> 'handle.invalid'`
		)
		.bind(JSON.stringify(dids))
		.all<{ did: string; handle: string }>();
	for (const row of results ?? []) handles.set(row.did, row.handle);
	return handles;
}

export interface CrowdedServer {
	server: string;
	/** Its groups that the list leaves out. */
	more: number;
}

/** The servers with more groups than the list gives them, most left out first. `home` has no
 *  limit, so pass it only when the list was given what it holds; accounts not resolved yet have
 *  no server page to send anyone to. */
export async function crowdedServers(
	db: Database,
	home: string | null,
	limit = 20
): Promise<CrowdedServer[]> {
	const { results } = await db
		.prepare(
			`SELECT server, COUNT(*) - ${DECLARED_PER_SERVER} AS more
			FROM (${visible(`${serverOf('i')} AS server`)}) servers
			WHERE server <> '' AND server <> ?
			GROUP BY server HAVING COUNT(*) > ${DECLARED_PER_SERVER}
			ORDER BY more DESC, server LIMIT ${limit}`
		)
		.bind(home ?? '')
		.all<CrowdedServer>();
	return results ?? [];
}

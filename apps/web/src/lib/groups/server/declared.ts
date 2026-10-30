// Which declared groups the groups list shows. Any account can declare itself a group, so one
// server could fill the list with them: each server gets at most DECLARED_PER_SERVER places,
// for its newest groups, except this site's own group host. A server's other groups are listed
// on a page of their own. A server is the PDS address in the account's DID document, as
// contrail resolved it when it indexed the account's records.
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

/** rsvp.atmo.declaration.listDeclared. With `server`, every group at that server. Otherwise each
 *  server's newest DECLARED_PER_SERVER, and every group at `home`. */
export function declaredSource(params: URLSearchParams): RecordSource {
	const only = serverOrigin(params.get('server'));
	if (only) {
		return {
			conditions: [
				`r.rkey = 'self'`,
				`r.did IN (SELECT i.did FROM identities i WHERE ${serverOf('i')} = ?)`
			],
			params: [only]
		};
	}
	const home = serverOrigin(params.get('home'));
	const placed = visible(
		`d.uri, ${serverOf('i')} AS server, ROW_NUMBER() OVER (PARTITION BY ${serverOf('i')} ORDER BY d.time_us DESC, d.uri) AS place`
	);
	return {
		conditions: [
			`r.rkey = 'self'`,
			`r.uri IN (SELECT uri FROM (${placed}) placed WHERE place <= ${DECLARED_PER_SERVER}${home ? ' OR server = ?' : ''})`
		],
		params: home ? [home] : []
	};
}

export interface CrowdedServer {
	server: string;
	/** Its groups that the list leaves out. */
	more: number;
}

/** The servers with more groups than the list gives them, most left out first. `home` has no
 *  limit, and accounts not resolved yet have no server page to send anyone to. */
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

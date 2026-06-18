// apps/web/scripts/geocode-events.ts
// External geocode job (runs OFF Cloudflare): finds address-only events in the
// openmeet-atmo D1 that lack coordinates, geocodes each unique address through
// the config-selected Nominatim/LocationIQ client, writes geocode_cache, and
// _geo-updates the affected Meili docs. ONE job: "find work" and "geocode" are
// sequential steps sharing the cache, not two passes. Rate limiting is the
// sleep between calls — the whole reason geocoding stays off Workers.
//
// Run (backfill MUST point the geocoder at LocationIQ, never public Nominatim):
//   CF_API_TOKEN=… MEILI_URL=https://search.testnet.openmeet.net MEILI_KEY=… \
//   GEOCODER_URL=https://us1.locationiq.com/v1/search GEOCODER_KEY=… \
//     pnpm -C apps/web exec tsx scripts/geocode-events.ts --limit 50
import { createD1Client } from '../src/lib/search/server/d1-http';
import { createGeocoder, addressToQuery } from '../src/lib/search/server/geocoder';
import {
	isEligible,
	groupEventsByNorm,
	type GeocodeCacheRow,
	type WorklistEvent
} from '../src/lib/search/server/geocode-cache';
import { addressLocation } from '../src/lib/search/server/address-norm';
import { searchDocId } from '../src/lib/search/server/normalize';
import { MeiliEventIndex } from '../src/lib/search/server/meili-sink';

const env = process.env;
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string, def?: string) => {
	const i = argv.indexOf(name);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
};

const retryNegative = flag('--retry-negative');
const dryRun = flag('--dry-run');
const limit = Number(opt('--limit', '0')) || 0; // 0 = no cap
const sleepMs = Number(env.GEOCODE_SLEEP_MS ?? '1100');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Address-only worklist: events with a .address location and NO coordinate
// location, still discoverable. json_each walks locations[]; the "$type" key is
// quoted because it starts with $.
const WORKLIST_SQL = `
SELECT r.uri AS uri, r.did AS did, r.rkey AS rkey, r.record AS record
FROM records_event AS r
WHERE EXISTS (
    SELECT 1 FROM json_each(r.record, '$.locations')
    WHERE json_extract(value, '$."$type"') = 'community.lexicon.location.address')
  AND NOT EXISTS (
    SELECT 1 FROM json_each(r.record, '$.locations')
    WHERE json_extract(value, '$."$type"') IN (
      'community.lexicon.location.geo', 'community.lexicon.location.hthree'))
  AND (json_extract(r.record, '$.preferences.showInDiscovery') IS NULL
       OR json_extract(r.record, '$.preferences.showInDiscovery') != 0)
`;

async function main() {
	if (!env.CF_API_TOKEN) throw new Error('CF_API_TOKEN is required');
	if (!env.MEILI_URL || !env.MEILI_KEY) throw new Error('MEILI_URL and MEILI_KEY are required');
	if (!env.GEOCODER_KEY) {
		console.warn(
			'[geocode] GEOCODER_KEY is unset → using PUBLIC Nominatim. OK for a small drip; ' +
				'a bulk backfill against public Nominatim risks a silent IP ban. Use LocationIQ for backfill.'
		);
	}

	const d1 = createD1Client({
		accountId: env.CF_ACCOUNT_ID ?? '312f04a766eb64123dd955e2cc12ad5f',
		databaseId: env.CF_D1_DATABASE_ID ?? '65641d99-327d-4a16-b9c4-f7142f068152',
		apiToken: env.CF_API_TOKEN
	});
	const geocoder = createGeocoder(env);
	const meili = new MeiliEventIndex({
		url: env.MEILI_URL,
		apiKey: env.MEILI_KEY,
		indexUid: env.SEARCH_INDEX ?? 'events'
	});

	// Defensive: the table is created by geocode-cache.sql, but a fresh DB
	// shouldn't make the job crash before it can self-heal.
	await d1.query(
		`CREATE TABLE IF NOT EXISTS geocode_cache (
      address_norm TEXT PRIMARY KEY, lat REAL, lng REAL, precision TEXT,
      source TEXT NOT NULL, geocoded_at INTEGER NOT NULL,
      fail_count INTEGER NOT NULL DEFAULT 0, last_error TEXT)`
	);

	// Load the whole cache once (small) and decide eligibility in memory.
	const cacheRows = await d1.query<GeocodeCacheRow>(`SELECT * FROM geocode_cache`);
	const cache = new Map(cacheRows.map((r) => [r.address_norm, r]));

	// Worklist → WorklistEvent[] (parse record JSON, pull the .address location).
	const rawEvents = await d1.query<{ uri: string; did: string; rkey: string; record: string }>(
		WORKLIST_SQL
	);
	const events: WorklistEvent[] = [];
	for (const e of rawEvents) {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(e.record);
		} catch {
			continue;
		}
		const loc = addressLocation(record);
		if (loc) events.push({ uri: e.uri, did: e.did, rkey: e.rkey, loc });
	}

	const byNorm = groupEventsByNorm(events);
	const now = Date.now();
	const work = [...byNorm.entries()].filter(([norm]) => isEligible(cache.get(norm), now, retryNegative));
	const capped = limit > 0 ? work.slice(0, limit) : work;

	console.log(
		`[geocode] worklist events=${events.length} unique-addresses=${byNorm.size} ` +
			`eligible=${work.length} processing=${capped.length}${dryRun ? ' (dry-run)' : ''}`
	);

	let resolved = 0;
	let negative = 0;
	let transient = 0;
	for (const [norm, group] of capped) {
		const query = addressToQuery(group[0].loc);
		if (dryRun) {
			console.log(`[geocode] would geocode "${query}" -> ${group.length} event(s)`);
			continue;
		}
		try {
			const point = await geocoder.geocode(query);
			if (point) {
				await d1.query(
					`INSERT INTO geocode_cache (address_norm, lat, lng, precision, source, geocoded_at, fail_count, last_error)
					 VALUES (?, ?, ?, ?, ?, ?, 0, NULL)
					 ON CONFLICT(address_norm) DO UPDATE SET
					   lat=excluded.lat, lng=excluded.lng, precision=excluded.precision,
					   source=excluded.source, geocoded_at=excluded.geocoded_at, fail_count=0, last_error=NULL`,
					[norm, point.lat, point.lng, point.precision ?? null, env.GEOCODER_KEY ? 'locationiq' : 'nominatim', now]
				);
				await meili.updateGeo(
					group.map((e) => ({ id: searchDocId(e.uri), _geo: { lat: point.lat, lng: point.lng } }))
				);
				resolved++;
			} else {
				// No-match: write/increment a negative row (backoff handled by isEligible).
				await d1.query(
					`INSERT INTO geocode_cache (address_norm, lat, lng, precision, source, geocoded_at, fail_count, last_error)
					 VALUES (?, NULL, NULL, NULL, ?, ?, 1, 'no match')
					 ON CONFLICT(address_norm) DO UPDATE SET
					   source=excluded.source, geocoded_at=excluded.geocoded_at, fail_count=geocode_cache.fail_count+1, last_error='no match'`,
					[norm, env.GEOCODER_KEY ? 'locationiq' : 'nominatim', now]
				);
				negative++;
			}
		} catch (err) {
			// Transient (HTTP/network): DON'T write a negative row — retry next run.
			transient++;
			console.warn(`[geocode] transient error for "${query}": ${(err as Error).message}`);
		}
		await sleep(sleepMs);
	}

	console.log(`[geocode] done resolved=${resolved} negative=${negative} transient=${transient}`);
}

main().catch((e) => {
	console.error('[geocode] fatal:', e);
	process.exit(1);
});

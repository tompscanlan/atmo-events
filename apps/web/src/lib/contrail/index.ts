import { Contrail } from '@atmo-dev/contrail';
import { createHandler } from '@atmo-dev/contrail/server';
import { Client } from '@atcute/client';
import { config } from '../contrail.config';
import { getSpacesConfig, spacesAvailable } from '../spaces/config';
import {
	createMeiliSink,
	meiliSinkBackendFromEnv,
	applyMeiliSettings,
	type MeiliSinkBackend,
	type MeiliSinkEnv
} from '../search/server/meili-sink';
import {
	createOpenMeetSink,
	openMeetSinkBackendFromEnv,
	type OpenMeetSinkBackend,
	type OpenMeetSinkEnv
} from '../openmeet/server/openmeet-sink';

const spaces = getSpacesConfig();
if (!spacesAvailable()) {
	console.warn(
		'[contrail/spaces] No service DID configured — spaces features will be inactive. Run `pnpm tunnel` in dev to enable.'
	);
}

// The Meili search sink reads its backend from this module-level holder rather
// than construction-time config: in a Cloudflare Worker the env
// (SEARCH_SINK_URL/KEY) only exists per invocation, while `contrail` is built
// once at module load. ensureInit(db, env) — called by the cron and xrpc
// handlers, which have env — populates it before ingest fires the sink; the
// sink no-ops until then. The SSR read path calls ensureInit(db) with no env,
// which is fine: reads never ingest, so the sink never fires there.
let searchSinkBackend: MeiliSinkBackend | null = null;

// The geocode cache lives in D1; the sink reads it (read-only, best-effort) to
// reproduce the _geo the external geocode job writes, so a live update doesn't
// drop it. Like searchSinkBackend, it's a module-level holder the env-bearing
// ensureInit populates — the sink no-ops on it until then.
let geocodeCacheDb: D1Database | null = null;

// The OpenMeet intake sink (fork delta — see $lib/openmeet/server/openmeet-sink)
// arms from the same per-invocation env as the search sink, via its own holder.
// Registered ONLY here, on the runtime Worker — deliberately absent from
// contrail.config.ts, so the `contrail` CLI (`pnpm backfill` / `refresh`) cannot
// replay the whole index through the frozen platform's intake API in one shot.
let openMeetSinkBackend: OpenMeetSinkBackend | null = null;

export const contrail = new Contrail({
	...config,
	...(spaces ? { spaces } : {}),
	sinks: [
		createMeiliSink(
			() => searchSinkBackend,
			() => geocodeCacheDb
		),
		createOpenMeetSink(() => openMeetSinkBackend)
	]
});

let initialized = false;
let sinkConfigured = false;

export async function ensureInit(db: D1Database, env?: MeiliSinkEnv & OpenMeetSinkEnv) {
	geocodeCacheDb = db;
	if (!initialized) {
		await contrail.init(db);
		initialized = true;
	}
	// Arm the OpenMeet sink from the same env. No remote handshake to do (unlike
	// Meili's settings PATCH), so this is a plain resolve-and-hold: unset
	// OPENMEET_SINK_URL leaves the backend null and the sink inert, which is what
	// keeps a dev or preview instance from feeding production.
	if (env && !openMeetSinkBackend) {
		openMeetSinkBackend = openMeetSinkBackendFromEnv(env);
	}
	// Configure the search sink once, on the first env-bearing call. Apply the
	// index settings (which also auto-creates the index) BEFORE arming the sink,
	// so a Meili outage degrades to "no search feed this worker" rather than
	// upserting into an index whose filters the read path can't use. Failure is
	// isolated: ingest and reads must continue even when Meili is unreachable.
	if (env && !sinkConfigured) {
		const backend = meiliSinkBackendFromEnv(env);
		if (backend) {
			try {
				await applyMeiliSettings(backend);
				searchSinkBackend = backend;
				sinkConfigured = true;
			} catch (e) {
				console.error('[search-sink] applySettings failed; sink disabled this cycle:', e);
			}
		}
	}
}

const handle = createHandler(contrail);

/**
 * Server-side: fully typed @atcute/client that routes through contrail in-process.
 * No HTTP roundtrip — calls createHandler directly.
 */
export function getServerClient(db: D1Database) {
	return new Client({
		handler: async (pathname, init) => {
			await ensureInit(db);
			const url = new URL(pathname, 'http://localhost');
			return handle(new Request(url, init), db) as Promise<Response>;
		}
	});
}

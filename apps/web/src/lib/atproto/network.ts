import { env as publicEnv } from '$env/dynamic/public';

/**
 * Every atproto-network address atmo talks to, in one place.
 *
 * Unset, each one is what atmo has always used (the public network). A
 * deployment pointed at a private network (a devnet, a sandbox) sets them to its
 * own services. Dynamic public env, so the same values reach server code, the
 * Worker and the browser.
 *
 *   PUBLIC_ATPROTO_PLC_URL            DID directory (default https://plc.directory)
 *   PUBLIC_ATPROTO_SLINGSHOT_URL      identity resolver (contrail's default Slingshot)
 *   PUBLIC_ATPROTO_JETSTREAM_URLS     comma-separated feed servers (contrail's defaults)
 *   PUBLIC_ATPROTO_RELAY_URLS         comma-separated relays, for backfill (contrail's default)
 *   PUBLIC_ATPROTO_CONSTELLATION_URL  backlink service (contrail's default Constellation)
 *   PUBLIC_ATPROTO_SIGNUP_PDS         server new accounts are created on
 *   PUBLIC_ATPROTO_DOH_URL            DNS-over-HTTPS resolver for handle lookups
 *   PUBLIC_ATPROTO_APPVIEW_URL        public Bluesky API, for profiles
 *   PUBLIC_ATPROTO_TYPEAHEAD_URL      actor search
 *   PUBLIC_ATPROTO_STATS_URL          Microcosm record stats
 *   PUBLIC_ATPROTO_BLOB_URL_TEMPLATE  image URL; {did}, {cid} and {format} are filled in
 *
 * PUBLIC_ATPROTO_SEALED=true is for a network that must not reach the public
 * one. The addresses that have a stand-in on a private network (directory,
 * identity resolver, feed, relay, sign-up, image URL) must then all be set, or
 * reading the settings throws. Those with none (DNS lookups, backlinks,
 * profiles, actor search, stats) turn off unless set, so nothing falls back to a
 * public service.
 */
export type NetworkSettings = {
	sealed: boolean;
	/** undefined: the libraries' own default (plc.directory). */
	plcUrl: string | undefined;
	/** undefined: contrail's default Slingshot. */
	slingshotUrl: string | undefined;
	/** undefined: contrail's default feed servers. */
	jetstreams: string[] | undefined;
	/** undefined: contrail's default relay. */
	relays: string[] | undefined;
	/** undefined: contrail's default Constellation. null: no backlink lookups. */
	constellationUrl: string | null | undefined;
	/** undefined: the build's own sign-up server. */
	signUpPds: string | undefined;
	/** null: no DNS lookups, handles resolve over HTTPS only. */
	dohUrl: string | null;
	/** null: no profile lookups. */
	appviewUrl: string | null;
	/** null: no actor search. */
	typeaheadUrl: string | null;
	/** null: no record stats. */
	statsUrl: string | null;
	blobUrlTemplate: string;
};

type Env = Record<string, string | undefined>;

const PUBLIC_DEFAULTS = {
	dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query',
	appviewUrl: 'https://public.api.bsky.app',
	typeaheadUrl: 'https://typeahead.waow.tech',
	statsUrl: 'https://ufos-api.microcosm.blue',
	blobUrlTemplate: 'https://cdn.bsky.app/img/feed_thumbnail/plain/{did}/{cid}@{format}'
};

function value(env: Env, key: string): string | undefined {
	const v = env[`PUBLIC_ATPROTO_${key}`]?.trim();
	return v ? v : undefined;
}

function origin(raw: string, key: string): string {
	try {
		return new URL(raw).toString().replace(/\/$/, '');
	} catch {
		throw new Error(`PUBLIC_ATPROTO_${key} is not a URL: ${raw}`);
	}
}

export function readNetwork(env: Env): NetworkSettings {
	const sealed = value(env, 'SEALED') === 'true';
	const url = (key: string) => {
		const v = value(env, key);
		return v === undefined ? undefined : origin(v, key);
	};

	const plcUrl = url('PLC_URL');
	const slingshotUrl = url('SLINGSHOT_URL');
	const list = (key: string) => {
		const urls = value(env, key)
			?.split(',')
			.map((u) => u.trim())
			.filter(Boolean)
			.map((u) => origin(u, key));
		return urls?.length ? urls : undefined;
	};
	const jetstreams = list('JETSTREAM_URLS');
	const relays = list('RELAY_URLS');
	const constellationUrl = url('CONSTELLATION_URL');
	const signUpPds = url('SIGNUP_PDS');
	const blobUrlTemplate = value(env, 'BLOB_URL_TEMPLATE');

	if (sealed) {
		const missing = [
			['PLC_URL', plcUrl],
			['SLINGSHOT_URL', slingshotUrl],
			['JETSTREAM_URLS', jetstreams],
			['RELAY_URLS', relays],
			['SIGNUP_PDS', signUpPds],
			['BLOB_URL_TEMPLATE', blobUrlTemplate]
		]
			.filter(([, v]) => v === undefined)
			.map(([k]) => `PUBLIC_ATPROTO_${k}`);
		if (missing.length) {
			throw new Error(`PUBLIC_ATPROTO_SEALED is set but ${missing.join(', ')} is not`);
		}
	}

	// Unset means today's public service, unless sealed, where it means off.
	const orDefault = (key: string, fallback: string) => {
		const v = url(key);
		if (v !== undefined) return v;
		return sealed ? null : fallback;
	};

	return {
		sealed,
		plcUrl,
		slingshotUrl,
		jetstreams,
		relays,
		constellationUrl: constellationUrl ?? (sealed ? null : undefined),
		signUpPds,
		dohUrl: orDefault('DOH_URL', PUBLIC_DEFAULTS.dohUrl),
		appviewUrl: orDefault('APPVIEW_URL', PUBLIC_DEFAULTS.appviewUrl),
		typeaheadUrl: orDefault('TYPEAHEAD_URL', PUBLIC_DEFAULTS.typeaheadUrl),
		statsUrl: orDefault('STATS_URL', PUBLIC_DEFAULTS.statsUrl),
		blobUrlTemplate: blobUrlTemplate ?? PUBLIC_DEFAULTS.blobUrlTemplate
	};
}

/** The settings of this deployment. Read per call so a Worker's env is current. */
export function network(): NetworkSettings {
	return readNetwork(publicEnv);
}

/** An image URL for a blob, from the deployment's template. */
export function blobUrl(
	did: string,
	cid: string,
	format: 'webp' | 'jpeg' | 'png' = 'webp',
	settings: NetworkSettings = network()
): string {
	return settings.blobUrlTemplate
		.replace('{did}', did)
		.replace('{cid}', cid)
		.replace('{format}', format);
}

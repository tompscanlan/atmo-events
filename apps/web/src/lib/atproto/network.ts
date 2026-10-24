import { env as publicEnv } from '$env/dynamic/public';

// Every atproto-network address atmo talks to. Unset, each keeps the public network's.
// undefined: the library's own default. null: that service is off.
export type NetworkSettings = {
	sealed: boolean;
	plcUrl: string | undefined;
	slingshotUrl: string | undefined;
	jetstreams: string[] | undefined;
	relays: string[] | undefined;
	constellationUrl: string | null | undefined;
	signUpPds: string | undefined;
	dohUrl: string | null;
	appviewUrl: string | null;
	typeaheadUrl: string | null;
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

	// A sealed network must not reach the public one: the services it has its own copy
	// of must all be set, and the others turn off below instead of falling back.
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

let memo: { env: Env; settings: NetworkSettings } | undefined;

/** The settings of this deployment, read again only when its env object changes. */
export function network(): NetworkSettings {
	if (memo?.env !== publicEnv) memo = { env: publicEnv, settings: readNetwork(publicEnv) };
	return memo.settings;
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

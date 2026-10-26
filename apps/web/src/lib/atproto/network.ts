import { env as publicEnv } from '$env/dynamic/public';

// Every atproto-network address atmo talks to, each a setting named after its service.
// Unset, each keeps the public network's; undefined leaves the library on its own default.
export type NetworkSettings = {
	plcUrl: string | undefined;
	slingshotUrl: string | undefined;
	jetstreams: string[] | undefined;
	relays: string[] | undefined;
	constellationUrl: string | undefined;
	signUpPdsUrl: string | undefined;
	dohUrl: string;
	appviewUrl: string;
	typeaheadUrl: string;
	ufosUrl: string;
	imageUrlTemplate: string;
};

type Env = Record<string, string | undefined>;

const PUBLIC_DEFAULTS = {
	dohUrl: 'https://mozilla.cloudflare-dns.com/dns-query',
	appviewUrl: 'https://public.api.bsky.app',
	typeaheadUrl: 'https://typeahead.waow.tech',
	ufosUrl: 'https://ufos-api.microcosm.blue',
	imageUrlTemplate: 'https://cdn.bsky.app/img/feed_thumbnail/plain/{did}/{cid}@{format}'
};

function value(env: Env, key: string): string | undefined {
	const v = env[`PUBLIC_${key}`]?.trim();
	return v ? v : undefined;
}

function origin(raw: string, key: string): string {
	try {
		return new URL(raw).toString().replace(/\/$/, '');
	} catch {
		throw new Error(`PUBLIC_${key} is not a URL: ${raw}`);
	}
}

export function readNetwork(env: Env): NetworkSettings {
	const url = (key: string) => {
		const v = value(env, key);
		return v === undefined ? undefined : origin(v, key);
	};
	const list = (key: string) => {
		const urls = value(env, key)
			?.split(',')
			.map((u) => u.trim())
			.filter(Boolean)
			.map((u) => origin(u, key));
		return urls?.length ? urls : undefined;
	};

	return {
		plcUrl: url('PLC_URL'),
		slingshotUrl: url('SLINGSHOT_URL'),
		jetstreams: list('JETSTREAM_URLS'),
		relays: list('RELAY_URLS'),
		constellationUrl: url('CONSTELLATION_URL'),
		signUpPdsUrl: url('SIGNUP_PDS_URL'),
		dohUrl: url('DOH_URL') ?? PUBLIC_DEFAULTS.dohUrl,
		appviewUrl: url('BSKY_APPVIEW_URL') ?? PUBLIC_DEFAULTS.appviewUrl,
		typeaheadUrl: url('TYPEAHEAD_URL') ?? PUBLIC_DEFAULTS.typeaheadUrl,
		ufosUrl: url('UFOS_URL') ?? PUBLIC_DEFAULTS.ufosUrl,
		imageUrlTemplate: value(env, 'IMAGE_URL_TEMPLATE') ?? PUBLIC_DEFAULTS.imageUrlTemplate
	};
}

let memo: { env: Env; settings: NetworkSettings } | undefined;

/** The settings of this deployment, read again only when its env object changes. */
export function network(): NetworkSettings {
	if (memo?.env !== publicEnv) memo = { env: publicEnv, settings: readNetwork(publicEnv) };
	return memo.settings;
}

/** An image URL for a blob, from the deployment's template. */
export function imageUrl(
	did: string,
	cid: string,
	format: 'webp' | 'jpeg' | 'png' = 'webp',
	settings: NetworkSettings = network()
): string {
	return settings.imageUrlTemplate
		.replace('{did}', did)
		.replace('{cid}', cid)
		.replace('{format}', format);
}

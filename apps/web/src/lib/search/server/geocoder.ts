// apps/web/src/lib/search/server/geocoder.ts
// One Nominatim-compatible geocoding client, config-selected. LocationIQ is
// API-compatible with Nominatim (same /search?q=&format=&limit= request, same
// lat/lon/type/class/display_name response — it IS hosted Nominatim), so this
// is one implementation parameterized by endpoint + optional key, not two
// behind an interface. Default = public Nominatim (parity with atmo today);
// set GEOCODER_KEY (+ GEOCODER_URL) to use LocationIQ. Used only by the
// external geocode job — geocoding never runs on the Worker hot path.

export interface GeoPoint {
	lat: number;
	lng: number;
	/** Provider-reported granularity tier (rooftop/street/locality/...). */
	precision?: string;
}

export interface Geocoder {
	geocode(q: string): Promise<GeoPoint | null>;
}

export interface GeocoderEnv {
	GEOCODER_URL?: string;
	GEOCODER_KEY?: string;
	GEOCODER_USER_AGENT?: string;
}

const DEFAULT_URL = 'https://nominatim.openstreetmap.org/search';
const DEFAULT_USER_AGENT = 'atmo-events (https://atmo.rsvp)';

// Same fixed order as the cache key, but a human-readable freeform query (commas,
// original case/diacritics) — both Nominatim and LocationIQ handle UTF-8 / non-
// Latin scripts. Freeform tolerates the messy data (city-in-name, JP street-only,
// trailing punctuation) a structured per-field query would drop.
const QUERY_FIELDS = ['name', 'street', 'locality', 'region', 'postalCode', 'country'];

export function addressToQuery(loc: Record<string, unknown>): string {
	return QUERY_FIELDS.map((f) => (typeof loc[f] === 'string' ? (loc[f] as string).trim() : ''))
		.filter((v) => v !== '')
		.join(', ');
}

type NominatimHit = {
	lat?: string;
	lon?: string;
	display_name?: string;
	type?: string;
	class?: string;
	place_rank?: number;
	addresstype?: string;
};

const ROOFTOP = new Set(['house', 'building', 'address', 'house_number']);
const STREET = new Set(['road', 'street', 'residential', 'pedestrian']);
const LOCALITY = new Set([
	'city',
	'town',
	'village',
	'hamlet',
	'suburb',
	'locality',
	'municipality',
	'administrative',
	'state',
	'region',
	'province',
	'country'
]);

export function derivePrecision(top: {
	type?: string;
	class?: string;
	place_rank?: number;
	addresstype?: string;
}): string {
	const t = top.addresstype || top.type || '';
	if (ROOFTOP.has(t) || (top.place_rank ?? 0) >= 30) return 'rooftop';
	if (STREET.has(t) || top.class === 'highway') return 'street';
	if (LOCALITY.has(t) || top.class === 'boundary' || top.class === 'place') return 'locality';
	return t || 'unknown';
}

export function createGeocoder(env: GeocoderEnv = {}, fetchImpl: typeof fetch = fetch): Geocoder {
	const base = env.GEOCODER_URL || DEFAULT_URL;
	const key = env.GEOCODER_KEY;
	const userAgent = env.GEOCODER_USER_AGENT || DEFAULT_USER_AGENT;

	return {
		async geocode(q: string): Promise<GeoPoint | null> {
			const url = new URL(base);
			url.searchParams.set('q', q);
			url.searchParams.set('format', 'json');
			url.searchParams.set('limit', '1');
			if (key) url.searchParams.set('key', key);

			const res = await fetchImpl(url, {
				headers: { accept: 'application/json', 'user-agent': userAgent }
			});
			// Throw on transport/HTTP errors so the job treats them as TRANSIENT
			// (retry next run), distinct from an empty body = NO-MATCH (negative cache).
			if (!res.ok) throw new Error(`geocode request failed: ${res.status}`);

			const results = (await res.json()) as NominatimHit[];
			const top = Array.isArray(results) ? results[0] : undefined;
			if (!top) return null;

			const lat = Number(top.lat);
			const lng = Number(top.lon);
			if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

			return { lat, lng, precision: derivePrecision(top) };
		}
	};
}

// One place that knows how to read a human-readable location out of a record's
// `locations[]`, so every reader (the event page, cards, embeds, calendar export)
// agrees on it. The key case it centralizes: a pick the geocoder gave no ISO
// country code for is saved as a geo entry ALONE (the address lexicon requires a
// country), with the place's name on the geo entry's optional `name` — a reader
// that only looks at the address entry would show no location for it.

const ADDRESS_TYPE = 'community.lexicon.location.address';
const GEO_TYPE = 'community.lexicon.location.geo';

type LocationEntry = { $type?: string; [k: string]: unknown };

function str(source: LocationEntry | undefined, key: string): string | undefined {
	const v = source?.[key];
	return typeof v === 'string' && v.trim() ? v : undefined;
}

export interface LocationSummary {
	/** Address entry's name, else the geo entry's name. */
	name?: string;
	street?: string;
	locality?: string;
	region?: string;
	country?: string;
	/** Geo entry coordinates, as the raw lexicon strings. */
	lat?: string;
	lng?: string;
}

/** Normalize a record's `locations[]` into the fields a reader displays, folding
 *  the address entry and the companion geo entry. Returns null when there is no
 *  address or (named/located) geo entry to show — e.g. an FSQ/H3-only record. */
export function locationSummary(
	locations: ReadonlyArray<LocationEntry> | undefined | null
): LocationSummary | null {
	if (!locations?.length) return null;

	const address = locations.find((l) => l?.$type === ADDRESS_TYPE);
	const geo = locations.find((l) => l?.$type === GEO_TYPE);

	const summary: LocationSummary = {};
	if (address) {
		summary.name = str(address, 'name');
		summary.street = str(address, 'street');
		summary.locality = str(address, 'locality');
		summary.region = str(address, 'region');
		summary.country = str(address, 'country');
	}
	if (geo) {
		if (!summary.name) summary.name = str(geo, 'name');
		summary.lat = str(geo, 'latitude');
		summary.lng = str(geo, 'longitude');
	}

	return Object.keys(summary).length > 0 ? summary : null;
}

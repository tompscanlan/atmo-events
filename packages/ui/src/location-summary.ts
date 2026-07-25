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

/** Trim a place name down to something a card can show. Records authored by other
 *  clients often put a whole reverse-geocoded string in `name` rather than a place
 *  name, and a full postal address crowds everything else out of a card. Keep
 *  leading segments while they fit, always keeping at least the first; a name that
 *  already fits is returned untouched. Readers with room for the whole string (the
 *  event page, the calendar exports) should not use this. */
export function compactPlaceName(name: string, maxLength = 40): string {
	if (name.length <= maxLength) return name;

	const segments = name
		.split(',')
		.map((segment) => segment.trim())
		.filter(Boolean);
	if (segments.length === 0) return name;

	let label = segments[0];
	for (const segment of segments.slice(1)) {
		const extended = `${label}, ${segment}`;
		if (extended.length > maxLength) break;
		label = extended;
	}
	return label;
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

	// Assign conditionally: setting a key to undefined would still create it, and an
	// entry present but empty would then read as something to show.
	const summary: LocationSummary = {};
	const set = (key: keyof LocationSummary, value: string | undefined) => {
		if (value) summary[key] = value;
	};
	if (address) {
		set('name', str(address, 'name'));
		set('street', str(address, 'street'));
		set('locality', str(address, 'locality'));
		set('region', str(address, 'region'));
		set('country', str(address, 'country'));
	}
	if (geo) {
		if (!summary.name) set('name', str(geo, 'name'));
		set('lat', str(geo, 'latitude'));
		set('lng', str(geo, 'longitude'));
	}

	return Object.keys(summary).length > 0 ? summary : null;
}

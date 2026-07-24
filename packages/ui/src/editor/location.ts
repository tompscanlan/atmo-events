// Pure mapping between /api/geocoding, editor state and a record's `locations[]`.
// Shared so the plain and recurring save paths cannot drift.
import type { EventLocation } from './types.js';

export const ADDRESS_TYPE = 'community.lexicon.location.address';
export const GEO_TYPE = 'community.lexicon.location.geo';

// place and boundary describe the address itself, so their name usually restates
// a persisted field; keep it only when it adds information. Other classes are
// named features whose name is the point of the pick, even when it matches a town.
const ADDRESS_LIKE_CATEGORIES = new Set(['place', 'boundary']);

// highway also covers named features such as bus stops and trailheads. Only road
// types use the redundancy check; preserve unknown types because an extra name is
// cosmetic while a dropped one is data loss.
const ROAD_HIGHWAY_TYPES = new Set([
	'motorway',
	'motorway_link',
	'trunk',
	'trunk_link',
	'primary',
	'primary_link',
	'secondary',
	'secondary_link',
	'tertiary',
	'tertiary_link',
	'unclassified',
	'residential',
	'living_street',
	'service',
	'road',
	'track',
	'path',
	'footway',
	'cycleway',
	'pedestrian',
	'bridleway',
	'steps'
]);

// A postal code is a code, not a name, whichever class carries it.
const POSTAL_TYPES = new Set(['postcode', 'postal_code']);

function isAddressLike(category: string, placeType: string): boolean {
	if (ADDRESS_LIKE_CATEGORIES.has(category)) return true;
	if (category === 'highway') return ROAD_HIGHWAY_TYPES.has(placeType);
	return false;
}

// ISO 3166-1 alpha-2, which is what both providers return, and the code the
// address lexicon wants. The subdivision fallback reads the country half of an
// ISO 3166-2 value ("US-IL" -> "US") from an `ISO3166-2` / `ISO3166-2-lvl4` key.
const COUNTRY_CODE = /^[A-Za-z]{2}$/;
const SUBDIVISION_KEY = /^ISO3166-2(-lvl\d+)?$/;
const SUBDIVISION_VALUE = /^([A-Za-z]{2})-\S+$/;

/** Normalized GET /api/geocoding result, never the raw provider object. `name` is
 *  the provider's feature name; category/placeType are its OSM class/type. */
export interface GeocodeResponse {
	lat?: number;
	lng?: number;
	label?: string;
	name?: string;
	category?: string;
	placeType?: string;
	address?: Record<string, string>;
}

function clean(v: unknown): string {
	return typeof v === 'string' ? v.trim() : '';
}

// No diacritic normalization: an accented difference keeps the name, the safe direction.
function fold(v: string): string {
	return v.trim().toLowerCase();
}

// Do not let Number('') turn a blank coordinate into Null Island.
function coordFromString(v: unknown): number {
	if (typeof v !== 'string') return NaN;
	const s = v.trim();
	return s === '' ? NaN : Number(s);
}

// Meilisearch drops the whole _geo batch on one invalid point.
function coordsInRange(lat: number, lng: number): boolean {
	return (
		Number.isFinite(lat) &&
		Number.isFinite(lng) &&
		lat >= -90 &&
		lat <= 90 &&
		lng >= -180 &&
		lng <= 180
	);
}

/** Resolve the place name to store, or undefined. `stored` is the values the
 *  record will ACTUALLY persist (so it is empty when no address entry will be
 *  emitted); for an address-like class a name equal to one of them is dropped.
 *  The name itself is always the geocoder's authoritative `name`, which is set
 *  only for genuinely named features — so an unnamed result (building=yes) yields
 *  none, and the display label, which for such a result is just a house number,
 *  is never used as a fallback. */
function resolvePlaceName(
	data: GeocodeResponse,
	stored: ReadonlyArray<string>
): string | undefined {
	const category = clean(data.category);
	const placeType = clean(data.placeType);
	// `name` alone cannot distinguish a venue from a city.
	if (!category && !placeType) return undefined;
	if (POSTAL_TYPES.has(placeType)) return undefined;

	const name = clean(data.name);
	if (!name) return undefined;
	if (!isAddressLike(category, placeType)) return name;

	const folded = fold(name);
	return stored.some((v) => v && fold(v) === folded) ? undefined : name;
}

/** Resolve the ISO 3166 code for the address entry's required `country`. Both
 *  sources are the geocoder's own codes and both are shape-checked — nothing here
 *  guesses a code from the free-text country name, which stays out of scope (it
 *  needs a name->ISO map and a migration for the legacy records that carry one).
 *  Without either, the result states no country we can store, and
 *  buildLocationEntries emits no address entry rather than an invalid one. */
function resolveCountryCode(addr: Record<string, string>): string {
	const code = clean(addr.country_code);
	if (COUNTRY_CODE.test(code)) return code.toUpperCase();
	for (const [key, value] of Object.entries(addr)) {
		if (!SUBDIVISION_KEY.test(key)) continue;
		const match = SUBDIVISION_VALUE.exec(clean(value));
		if (match) return match[1].toUpperCase();
	}
	return '';
}

function resolveCoords(data: GeocodeResponse): { lat: number; lng: number } | undefined {
	const { lat, lng } = data;
	if (typeof lat === 'number' && typeof lng === 'number' && coordsInRange(lat, lng)) {
		return { lat, lng };
	}
	return undefined;
}

/** Map a geocoding response onto the editor's location state. */
export function geocodeResponseToLocation(data: GeocodeResponse): EventLocation {
	const addr = (data.address ?? {}) as Record<string, string>;
	const road = clean(addr.road);
	const houseNumber = clean(addr.house_number);
	const street = road ? (houseNumber ? `${road} ${houseNumber}` : road) : '';
	const locality =
		clean(addr.city) ||
		clean(addr.town) ||
		clean(addr.village) ||
		clean(addr.municipality) ||
		clean(addr.hamlet);
	const region = clean(addr.state) || clean(addr.county);
	// An ISO code, never the free-text country name, which may exceed the lexicon cap.
	const country = resolveCountryCode(addr);

	// A name is redundant only with what the record will ACTUALLY store. With a
	// country the address entry carries street/locality/region/country, so a name
	// restating one of those adds nothing. Without a country there is no address
	// entry (buildLocationEntries drops it), so none of those persist — the name is
	// then the only descriptor and must survive, riding on the geo entry. Compare
	// against the stored country CODE, never the free-text country name, which we
	// don't keep (so "France"/"FR" is not treated as a restatement).
	const name = resolvePlaceName(
		data,
		country ? [street, road, houseNumber, locality, region, country] : []
	);
	const coords = resolveCoords(data);

	return {
		...(name && { name }),
		...(street && { street }),
		...(locality && { locality }),
		...(region && { region }),
		...(country && { country }),
		...(coords && { coords })
	};
}

/** Build an address entry when country is present and a companion geo entry when
 *  coordinates are valid. Geo coordinates are strings; the address schema has no
 *  coordinate fields. */
export function buildLocationEntries(location: EventLocation): Array<Record<string, unknown>> {
	const entries: Array<Record<string, unknown>> = [];

	// `country` is required; omitting the whole address avoids an invalid record.
	if (location.country) {
		const address: Record<string, unknown> = { $type: ADDRESS_TYPE };
		if (location.name) address.name = location.name;
		if (location.street) address.street = location.street;
		if (location.locality) address.locality = location.locality;
		if (location.region) address.region = location.region;
		address.country = location.country;
		entries.push(address);
	}

	// Validate at this emitting chokepoint too: public prefill can supply coords.
	if (location.coords && coordsInRange(location.coords.lat, location.coords.lng)) {
		const geo: Record<string, unknown> = {
			$type: GEO_TYPE,
			latitude: String(location.coords.lat),
			longitude: String(location.coords.lng)
		};
		// With no address entry to hold it, the place's name would be lost. The geo
		// lexicon has its own optional `name`, so it goes there instead — never on
		// both entries.
		if (entries.length === 0 && location.name) geo.name = location.name;
		entries.push(geo);
	}

	return entries;
}

/** Rebuild an EventLocation from a record's `locations[]` — the inverse of
 *  buildLocationEntries, used when an editor reopens a saved event. Reads the
 *  address entry's fields AND the companion geo entry's name and coordinates, so
 *  a re-save (and the recurring-event builder, which authors records from this
 *  location) preserves the searchable _geo instead of dropping it.
 *
 *  Only the address+geo pair this module authors is read back. Other entry kinds
 *  in `locations[]` (FSQ, H3, a second geo) have no editor state to land in and
 *  are left out — an explicit location change replaces the array, which is what
 *  you want, since those entries describe the place being replaced. */
export function eventLocationFromEntries(
	entries: ReadonlyArray<Record<string, unknown>> | undefined
): EventLocation {
	const location: EventLocation = {};
	if (!entries) return location;

	const str = (source: Record<string, unknown>, k: string): string | undefined => {
		const v = source[k];
		return typeof v === 'string' && v.trim() ? v : undefined;
	};

	const address = entries.find((e) => e?.$type === ADDRESS_TYPE);
	if (address) {
		const name = str(address, 'name');
		const street = str(address, 'street');
		const locality = str(address, 'locality');
		const region = str(address, 'region');
		const country = str(address, 'country');
		if (name) location.name = name;
		if (street) location.street = street;
		if (locality) location.locality = locality;
		if (region) location.region = region;
		if (country) location.country = country;
	}

	// Read the geo entry even with no address entry: a pick the geocoder gave no
	// country code for is stored as a geo entry alone, carrying the place's name,
	// and dropping it on reopen would lose both the name and the event's _geo on
	// the next re-save.
	const geo = entries.find((e) => e?.$type === GEO_TYPE);
	if (geo) {
		if (!location.name) {
			const name = str(geo, 'name');
			if (name) location.name = name;
		}
		const lat = coordFromString(geo.latitude);
		const lng = coordFromString(geo.longitude);
		if (coordsInRange(lat, lng)) location.coords = { lat, lng };
	}

	return location;
}

/** Decide the `locations[]` a save should write. On a new event or an explicit
 *  location change it is rebuilt from the edited model; otherwise the record's
 *  existing entries are preserved WHOLESALE — so entry kinds this editor doesn't
 *  model (FSQ, H3, a second geo) survive an edit, and survive a recurrence, that
 *  didn't touch the location, instead of being silently dropped by a rebuild from
 *  the reduced editor state. Returns undefined when there is nothing to write (a
 *  removed location, or an unchanged event that had none); the caller sets or
 *  deletes accordingly. Shared by save.ts and RecurringModal.svelte so the plain
 *  save and the recurrence can't diverge on this. */
export function locationsForSave(args: {
	isNew: boolean;
	locationChanged: boolean;
	location: EventLocation | null;
	existing: ReadonlyArray<Record<string, unknown>> | undefined;
}): Array<Record<string, unknown>> | undefined {
	const { isNew, locationChanged, location, existing } = args;
	if (isNew || locationChanged) {
		return location ? buildLocationEntries(location) : undefined;
	}
	return existing ? existing.map((entry) => ({ ...entry })) : undefined;
}

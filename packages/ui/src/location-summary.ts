// One place that knows how to read a human-readable location out of a record's
// `locations[]`, so every reader (the event page, cards, embeds, calendar export)
// agrees on it. The key case it centralizes: a pick the geocoder gave no ISO
// country code for is saved as a geo entry ALONE (the address lexicon requires a
// country), with the place's name on the geo entry's optional `name` — a reader
// that only looks at the address entry would show no location for it.

import { coordsUsableForDisplay } from './editor/location.js';

const ADDRESS_TYPE = 'community.lexicon.location.address';
const GEO_TYPE = 'community.lexicon.location.geo';

// Whether ONE comma segment names a place, as opposed to being a house number or a
// postcode. Two shapes of code, because a house number is not always digits alone:
// no letter at all ("1234"), or a SHORT mix of letters and digits ("12A", "221B",
// "SW1A 1AA", "K1A 0B1"). The length bound is what separates those from a place
// genuinely named with a digit in it ("Studio 54", "1100 Louisiana Blvd SE"), and it
// errs long on purpose: a segment wrongly called a code is still kept, just with the
// following segment appended for context.
//
// Any-script throughout — \p{Nd} not \d, so an Arabic-Indic or Devanagari house
// number ("۱۲A") is read as the code it is rather than as a place name.
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;
const CODE_MAX_LENGTH = 8;

function namesAPlace(segment: string): boolean {
	if (!HAS_LETTER.test(segment)) return false;
	return !(HAS_DIGIT.test(segment) && segment.length <= CODE_MAX_LENGTH);
}

type LocationEntry = { $type?: string; [k: string]: unknown };

// Trim what comes out, not just what gets tested: records hold hand-entered values
// with trailing spaces ("Copenhagen "), and passing those through put a space before
// the comma in every joined label and map query built from them.
function str(source: LocationEntry | undefined, key: string): string | undefined {
	const v = source?.[key];
	if (typeof v !== 'string') return undefined;
	const trimmed = v.trim();
	return trimmed ? trimmed : undefined;
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
	let taken = 1;
	for (const segment of segments.slice(1)) {
		const extended = `${label}, ${segment}`;
		if (extended.length > maxLength) break;
		label = extended;
		taken++;
	}
	// A reverse-geocoded string often leads with a house number or a postcode, and
	// trimming to those alone leaves "1234" or "12A" — worse than no trim, because it
	// reads as the place's name rather than as a truncation. Run on to the first
	// segment that names something, even though that overruns the budget: too long
	// beats actively misleading. A name with nothing to run on to is left as it is.
	//
	// Ask this of the segments INDIVIDUALLY, never of the joined label: two codes
	// together ("12A, 60651") clear the length bound between them and would read as
	// a name, which is the failure this whole branch exists to prevent.
	if (segments.slice(0, taken).some(namesAPlace)) {
		// Something in reach names a place, so no run-on is needed — but do not END on
		// a segment that names nothing. "Nortons Brewing Company, 125" reads as a
		// truncation bug: the house number tells a reader nothing and takes the room
		// the locality/region context would use. Trim back to the last naming segment.
		let end = taken;
		while (end > 1 && !namesAPlace(segments[end - 1])) end--;
		return segments.slice(0, end).join(', ');
	}

	const named = segments.findIndex(namesAPlace);
	if (named >= taken) {
		// Re-joining puts a space after every comma, so the run-on can come out
		// longer than what came in. Compaction that adds characters is no
		// compaction: hand back the original instead.
		const runOn = segments.slice(0, named + 1).join(', ');
		return runOn.length <= name.length ? runOn : name;
	}
	return label;
}

/** A bare point in the same form the editor and the event page show, so a record
 *  with coordinates and nothing else still reads as a location. Empty when the
 *  coordinates are unusable: blank or non-numeric, outside WGS84, or the 0,0
 *  sentinel — a record written by another client can hold a point the editor and
 *  the search normalizer would both reject, and rendering it would state a
 *  position that does not exist. Number('') is 0, so the blank check cannot be
 *  skipped.
 *
 *  Held to `coordsUsableForDisplay`, the same bound the map links use, and for the
 *  same reason: this string is the LAST-RESORT label, reached only when the record
 *  has no address text and no name. So it is the one case where a rejected point
 *  leaves nothing to show — which is correct, because 0,0 is what a record carries
 *  when nobody could geocode the place, i.e. exactly a record with no position. A
 *  looser bound here would also re-arm the map link: readers fall back to querying
 *  the label when they have no point to query, so a rendered "0.00000, 0.00000"
 *  becomes a Google Maps search for the Gulf of Guinea. */
export function formatPoint(lat: string | undefined, lng: string | undefined): string {
	if (!lat?.trim() || !lng?.trim()) return '';
	const latitude = Number(lat);
	const longitude = Number(lng);
	if (!coordsUsableForDisplay(latitude, longitude)) return '';
	return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

/** The address parts worth appending after `name`, in order, dropping any that
 *  something already shown states. Two sources of repetition, both live on
 *  atmo today:
 *   - the name restates a field, because a name written by another client is
 *     often a whole reverse-geocoded string ("Cafe, Paris" + locality Paris);
 *   - the fields restate each other, because in a city-state the locality and
 *     the region are the same place ("Berlin, Berlin", "Zürich, Zürich").
 *  Matching is on whole comma segments, so a name that merely contains the word
 *  ("Paris Street Cafe") does not swallow the locality.
 *
 *  Positional: the result has one slot per input, `undefined` where a part was
 *  dropped, so a caller that lays its fields out separately (the event page shows
 *  street+locality on one line and the whole address on another) can keep them
 *  apart and still get the same de-duplication a single joined label gets. */
export function dropRepeats(
	name: string | undefined,
	parts: ReadonlyArray<string | undefined>
): Array<string | undefined> {
	const seen = new Set(
		(name ?? '')
			.split(',')
			.map((segment) => segment.trim().toLowerCase())
			.filter(Boolean)
	);

	return parts.map((part) => {
		const value = part?.trim();
		if (!value) return undefined;
		const key = value.toLowerCase();
		if (seen.has(key)) return undefined;
		seen.add(key);
		return value;
	});
}

function withoutRepeats(name: string | undefined, parts: Array<string | undefined>): string[] {
	return dropRepeats(name, parts).filter((v): v is string => Boolean(v));
}

/** The location string for a space-constrained reader (cards, embeds). The place
 *  name leads — it is the point of the pick, and showing "Chicago, Illinois" for
 *  an event in Humboldt Park is the very bug this module exists to fix — with
 *  locality/region appended for context only while the whole thing still fits.
 *  A record with no name keeps exactly the locality/region label it had before. */
export function locationShortLabel(
	locations: ReadonlyArray<LocationEntry> | undefined | null,
	maxLength = 40
): string | undefined {
	const summary = locationSummary(locations);
	if (!summary) return undefined;

	if (!summary.name) {
		const context = withoutRepeats(undefined, [summary.locality, summary.region]).join(', ');
		return context || formatPoint(summary.lat, summary.lng) || undefined;
	}

	// Trim first, then de-duplicate against what will actually be shown: trimming
	// can drop the very segment that made a context part redundant.
	const name = compactPlaceName(summary.name, maxLength);
	const context = withoutRepeats(name, [summary.locality, summary.region]).join(', ');
	if (!context) return name;
	const combined = `${name}, ${context}`;
	return combined.length <= maxLength ? combined : name;
}

/** The location string for a reader with room for all of it (the calendar
 *  exports). Never trimmed, and it carries the name and the country the short
 *  label drops: a calendar app wants the whole address in LOCATION. */
export function locationFullLabel(
	locations: ReadonlyArray<LocationEntry> | undefined | null
): string | undefined {
	const summary = locationSummary(locations);
	if (!summary) return undefined;

	const context = withoutRepeats(summary.name, [
		summary.street,
		summary.locality,
		summary.region,
		summary.country
	]);
	const parts = summary.name ? [summary.name, ...context] : context;
	return parts.length > 0
		? parts.join(', ')
		: formatPoint(summary.lat, summary.lng) || undefined;
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

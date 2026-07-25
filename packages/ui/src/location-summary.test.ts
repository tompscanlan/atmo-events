import { describe, expect, it } from 'vitest';
import { compactPlaceName, locationSummary } from './location-summary';

const ADDRESS = 'community.lexicon.location.address';
const GEO = 'community.lexicon.location.geo';

describe('locationSummary', () => {
	it('reads an address entry, with its name', () => {
		expect(
			locationSummary([
				{
					$type: ADDRESS,
					name: 'Humboldt Park',
					locality: 'Chicago',
					region: 'Illinois',
					country: 'US'
				}
			])
		).toEqual({ name: 'Humboldt Park', locality: 'Chicago', region: 'Illinois', country: 'US' });
	});

	it('folds the companion geo entry coordinates in', () => {
		const summary = locationSummary([
			{ $type: ADDRESS, locality: 'Chicago', country: 'US' },
			{ $type: GEO, latitude: '41.9', longitude: '-87.7' }
		]);
		expect(summary).toEqual({ locality: 'Chicago', country: 'US', lat: '41.9', lng: '-87.7' });
	});

	it('falls back to the geo entry name when there is no address entry', () => {
		// The countryless pick's shape — the datum every non-full-page reader used to
		// miss because it only looked at the address entry.
		expect(
			locationSummary([{ $type: GEO, name: 'Humboldt Park', latitude: '41.9', longitude: '-87.7' }])
		).toEqual({ name: 'Humboldt Park', lat: '41.9', lng: '-87.7' });
	});

	it('prefers the address entry name over the geo entry name', () => {
		const summary = locationSummary([
			{ $type: ADDRESS, name: 'From Address', country: 'US' },
			{ $type: GEO, name: 'From Geo', latitude: '41.9', longitude: '-87.7' }
		]);
		expect(summary?.name).toBe('From Address');
	});

	it('ignores blank strings', () => {
		expect(
			locationSummary([{ $type: ADDRESS, name: '   ', locality: 'Chicago', country: 'US' }])
		).toEqual({ locality: 'Chicago', country: 'US' });
	});

	it('returns null when there is nothing to show', () => {
		// A geo entry with only coordinates (no name) yields lat/lng but no display
		// text; an FSQ/H3-only record, an empty list, and undefined yield null.
		expect(locationSummary([{ $type: GEO, latitude: '41.9', longitude: '-87.7' }])).toEqual({
			lat: '41.9',
			lng: '-87.7'
		});
		expect(
			locationSummary([{ $type: 'community.lexicon.location.fsq', fsq_place_id: 'x' }])
		).toBeNull();
		expect(locationSummary([])).toBeNull();
		expect(locationSummary(undefined)).toBeNull();
		expect(locationSummary(null)).toBeNull();
	});

	it('does not report an address entry that carries no fields', () => {
		// Assigning undefined would still create the key, which would make an empty
		// entry read as something to show.
		expect(locationSummary([{ $type: ADDRESS }])).toBeNull();
		expect(locationSummary([{ $type: ADDRESS, street: '   ' }])).toBeNull();
	});
});

describe('compactPlaceName', () => {
	// Names taken verbatim from records already in the index. Most of the ones
	// carrying a place name and no address were written by other clients and hold a
	// whole reverse-geocoded string.
	it('leaves a name that already fits a card', () => {
		for (const name of [
			'Tokyo, Japan',
			'Humboldt Park',
			'San Francisco, California, United States',
			'WellNest, Crucifix Lane, London, UK',
			'Heanor Road, Ilkeston DE7 8TB, UK',
			'Dana Cafe, Crookes, Sheffield'
		]) {
			expect(compactPlaceName(name)).toBe(name);
		}
	});

	it('keeps the leading segments of a reverse-geocoded string', () => {
		expect(
			compactPlaceName('Peace Portal Drive, Blaine, Whatcom County, Washington, 98231, United States')
		).toBe('Peace Portal Drive, Blaine');
		expect(
			compactPlaceName('Funkhaus Berlin, Oberschöneweide, Treptow-Köpenick, Berlin, 12459, Germany')
		).toBe('Funkhaus Berlin, Oberschöneweide');
		expect(compactPlaceName('1100 Louisiana Blvd SE, Albuquerque, NM 87108')).toBe(
			'1100 Louisiana Blvd SE, Albuquerque'
		);
	});

	it('keeps the first segment even when it is the only one that fits', () => {
		// No postcode and only four commas, so a digit or comma count would miss it.
		expect(
			compactPlaceName(
				'Beaverdell, Area E (Beaverdell/West Boundary), Regional District of Kootenay Boundary, British Columbia, Canada'
			)
		).toBe('Beaverdell');
	});

	it('returns a long single-segment name unchanged rather than cutting a word', () => {
		const name = 'The Really Very Long Name Of One Single Place With No Commas At All';
		expect(compactPlaceName(name)).toBe(name);
	});
});

import { describe, expect, it } from 'vitest';
import { locationSummary } from './location-summary';

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
});

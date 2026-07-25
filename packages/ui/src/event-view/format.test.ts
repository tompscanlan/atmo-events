import { describe, expect, it } from 'vitest';
import { getLocationData } from './format';
import type { FlatEventRecord } from '../contrail.js';

const locations = (entries: Array<Record<string, unknown>>) =>
	entries as unknown as FlatEventRecord['locations'];

const ADDRESS = 'community.lexicon.location.address';
const GEO = 'community.lexicon.location.geo';

describe('getLocationData', () => {
	it('reads the address entry, leading with its name', () => {
		const data = getLocationData(
			locations([
				{
					$type: ADDRESS,
					name: 'Humboldt Park',
					locality: 'Chicago',
					region: 'Illinois',
					country: 'US'
				},
				{ $type: GEO, latitude: '41.9027884', longitude: '-87.7209107' }
			])
		);
		expect(data?.name).toBe('Humboldt Park');
		expect(data?.fullAddress).toBe('Chicago, Illinois, US');
		expect(data?.fullString).toBe('Humboldt Park, Chicago, Illinois, US');
	});

	it('falls back to a named geo entry when there is no address entry', () => {
		// A pick the geocoder gave no ISO country code for is saved as a geo entry
		// alone (the address lexicon requires a country). Without this the event view
		// showed no location at all for such a pick.
		const data = getLocationData(
			locations([
				{ $type: GEO, latitude: '41.9027884', longitude: '-87.7209107', name: 'Humboldt Park' }
			])
		);
		expect(data?.name).toBe('Humboldt Park');
		expect(data?.fullString).toBe('Humboldt Park');
		expect(data?.shortAddress).toBe('');
		// The map link points at the coordinates, which are better than the bare name.
		expect(data?.googleMapsUrl).toContain(encodeURIComponent('41.9027884,-87.7209107'));
	});

	it('shows the point for an unnamed geo-only record', () => {
		// It has a position, so rendering nothing would hide a location the editor
		// displays. Same form the editor uses for the same record.
		const data = getLocationData(locations([{ $type: GEO, latitude: '41.9', longitude: '-87.7' }]));
		expect(data?.fullString).toBe('41.90000, -87.70000');
		expect(data?.name).toBeUndefined();
		expect(data?.googleMapsUrl).toContain(encodeURIComponent('41.9,-87.7'));
	});

	it('returns null for a geo entry whose coordinates are not numbers', () => {
		expect(
			getLocationData(locations([{ $type: GEO, latitude: '', longitude: 'north' }]))
		).toBeNull();
	});

	it('returns null for entry kinds it cannot render', () => {
		expect(
			getLocationData(locations([{ $type: 'community.lexicon.location.fsq', fsq_place_id: 'x' }]))
		).toBeNull();
		expect(getLocationData(locations([]))).toBeNull();
		expect(getLocationData(undefined)).toBeNull();
	});
});

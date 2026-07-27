import { describe, expect, it } from 'vitest';
import {
	compactPlaceName,
	formatPoint,
	locationFullLabel,
	locationShortLabel,
	locationSummary
} from './location-summary';

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

describe('compactPlaceName — a segment that names nothing', () => {
	it('keeps going past a leading house number rather than returning it alone', () => {
		// Returning "1234" reads as the place's name, not as a truncation, so this
		// overruns the budget on purpose.
		expect(
			compactPlaceName('1234, Extremely Long Boulevard Name That Does Not Fit, Chicago, Illinois, US')
		).toBe('1234, Extremely Long Boulevard Name That Does Not Fit');
	});

	it('keeps going past an alphanumeric house number or a postcode', () => {
		// A house-number suffix ("12A", "221B") and most postcodes carry a letter, so
		// "does it contain a letter" is not enough to tell a code from a name.
		expect(
			compactPlaceName('12A, Boulevard of the Very Long and Distinguished Name, Paris, France')
		).toBe('12A, Boulevard of the Very Long and Distinguished Name');
		expect(
			compactPlaceName('SW1A 1AA, Extremely Long Boulevard Name That Does Not Fit, London, UK')
		).toBe('SW1A 1AA, Extremely Long Boulevard Name That Does Not Fit');
		expect(
			compactPlaceName('221B, Baker Street And A Very Long Continuation Here, London, UK')
		).toBe('221B, Baker Street And A Very Long Continuation Here');
	});

	it('keeps going past SEVERAL code-only segments', () => {
		// The decision is per segment, never on the joined label: "12A, 60651" clears
		// the length bound between them and would otherwise read as a place name.
		expect(
			compactPlaceName('12A, 60651, Extremely Long Boulevard Name That Does Not Fit, Chicago, US')
		).toBe('12A, 60651, Extremely Long Boulevard Name That Does Not Fit');
		expect(
			compactPlaceName(
				'SW1A 1AA, 221B, Extremely Long Boulevard Name That Does Not Fit, London, UK'
			)
		).toBe('SW1A 1AA, 221B, Extremely Long Boulevard Name That Does Not Fit');
	});

	it('reads a house number written in any script', () => {
		// \p{Nd}, not \d — Arabic-Indic digits are digits.
		expect(
			compactPlaceName('۱۲A, Boulevard of the Very Long and Distinguished Name, Paris, France')
		).toBe('۱۲A, Boulevard of the Very Long and Distinguished Name');
	});

	it('does not END on a segment that names nothing', () => {
		// "Nortons Brewing Company, 125" reads as a truncation bug — the house number
		// tells a reader nothing and takes the room the locality/region would use.
		expect(
			compactPlaceName(
				'Nortons Brewing Company, 125, North Saint Francis Street, Wichita, Sedgwick County, Kansas, 67202, United States'
			)
		).toBe('Nortons Brewing Company');
		// Trims back over as many trailing codes as it takes.
		expect(
			compactPlaceName('Venue Name Here, 12A, 60651, Extremely Long Boulevard That Does Not Fit')
		).toBe('Venue Name Here');
	});

	it('leaves a code that is not at the END of the label', () => {
		// The rule is only about what the label ENDS on. An interior postcode is noise
		// but it does not read as the place's name, and dropping mid-label segments
		// would be a different (larger) change to what compaction means.
		expect(compactPlaceName('Funkhaus, Oberschöneweide, 12459, Berlin, Germany')).toBe(
			'Funkhaus, Oberschöneweide, 12459, Berlin'
		);
	});

	it('keeps a trailing code when nothing else in reach names a place', () => {
		// The run-on path still wins there: dropping back to "1234" alone would read as
		// the place's name rather than as a truncation.
		expect(
			compactPlaceName('1234, Extremely Long Boulevard Name That Does Not Fit, Chicago, US')
		).toBe('1234, Extremely Long Boulevard Name That Does Not Fit');
	});

	it('does not mistake a place named with a digit for a code', () => {
		// Long enough to read as a name, so it stands on its own and nothing runs on.
		expect(
			compactPlaceName('1100 Louisiana Blvd SE, A Very Long Second Segment Indeed, Albuquerque')
		).toBe('1100 Louisiana Blvd SE');
	});

	it('never returns more characters than it was given', () => {
		// Re-joining inserts a space after each comma, so a run-on across several
		// short segments can outgrow its input. Compaction that adds characters is no
		// compaction.
		const name = '1,2,3,abcdefghijklmnopqrstuvwxyzabcdefghij';
		expect(compactPlaceName(name).length).toBeLessThanOrEqual(name.length);
		expect(compactPlaceName(name)).toBe(name);
	});

	it('leaves a numeric-only name alone when there is nothing to extend to', () => {
		const name = '1234567890123456789012345678901234567890123456';
		expect(compactPlaceName(name)).toBe(name);
	});

	it('keeps a place genuinely named after a number', () => {
		expect(compactPlaceName('1919')).toBe('1919');
	});
});

describe('locationSummary — whitespace', () => {
	it('trims the values it hands back', () => {
		// Records hold hand-entered values with trailing spaces; passing them through
		// put a space before the comma in every label and map query built from them.
		const summary = locationSummary([
			{ $type: ADDRESS, name: 'Copenhagen ', street: 'Rådhuspladsen ', country: 'DK' }
		]);
		expect(summary?.name).toBe('Copenhagen');
		expect(summary?.street).toBe('Rådhuspladsen');
		expect(locationFullLabel([
			{ $type: ADDRESS, name: 'Copenhagen ', street: 'Rådhuspladsen ', country: 'DK' }
		])).toBe('Copenhagen, Rådhuspladsen, DK');
	});
});

describe('formatPoint', () => {
	it('renders a point at display precision', () => {
		expect(formatPoint('41.9027884', '-87.7209107')).toBe('41.90279, -87.72091');
	});

	it('renders nothing for a coordinate it cannot use', () => {
		expect(formatPoint('', '-87.72')).toBe('');
		expect(formatPoint('nope', '-87.72')).toBe('');
		expect(formatPoint(undefined, undefined)).toBe('');
	});
});

// The record the whole change exists for. A reader that shows "Chicago" for this
// is the original bug wearing a different hat, so both labels are pinned to it.
const HUMBOLDT = [
	{ $type: ADDRESS, name: 'Humboldt Park', locality: 'Chicago', region: 'Illinois', country: 'US' },
	{ $type: GEO, latitude: '41.9027884', longitude: '-87.7209107' }
];

describe('locationShortLabel', () => {
	it('leads with the place name and adds context while it fits', () => {
		expect(locationShortLabel(HUMBOLDT)).toBe('Humboldt Park, Chicago, Illinois');
	});

	it('drops the context rather than the name when both will not fit', () => {
		expect(
			locationShortLabel([
				{
					$type: ADDRESS,
					name: 'Old Kona Airport Park Benches on the Right',
					locality: 'Kailua-Kona',
					region: 'Hawaii',
					country: 'US'
				}
			])
		).toBe('Old Kona Airport Park Benches on the Right');
	});

	it('trims a name that is really a whole address, then adds only what the trim lost', () => {
		// De-duplication runs against the TRIMMED name, not the original: the trim
		// dropped "Washington", so the region is worth appending again, while
		// "Blaine" is already visible and is not repeated.
		expect(
			locationShortLabel([
				{
					$type: ADDRESS,
					name: 'Peace Portal Drive, Blaine, Whatcom County, Washington, 98231, United States',
					locality: 'Blaine',
					region: 'Washington',
					country: 'US'
				}
			])
		).toBe('Peace Portal Drive, Blaine, Washington');
	});

	it('shows exactly the locality/region label when the pick has no name', () => {
		expect(
			locationShortLabel([{ $type: ADDRESS, locality: 'Chicago', region: 'Illinois', country: 'US' }])
		).toBe('Chicago, Illinois');
	});

	it('reads the name off a geo entry when there is no address entry', () => {
		expect(
			locationShortLabel([
				{ $type: GEO, name: 'Humboldt Park', latitude: '41.9027884', longitude: '-87.7209107' }
			])
		).toBe('Humboldt Park');
	});

	it('shows the point for a record saved as bare coordinates', () => {
		expect(
			locationShortLabel([{ $type: GEO, latitude: '41.9027884', longitude: '-87.7209107' }])
		).toBe('41.90279, -87.72091');
	});

	it('shows nothing when there is no entry kind it can read', () => {
		expect(locationShortLabel([])).toBeUndefined();
		expect(locationShortLabel(undefined)).toBeUndefined();
		expect(locationShortLabel([{ $type: 'community.lexicon.location.fsq' }])).toBeUndefined();
		expect(locationShortLabel([{ $type: GEO, latitude: '', longitude: '' }])).toBeUndefined();
	});
});

describe('locationFullLabel', () => {
	it('keeps the name and the country, untrimmed', () => {
		expect(locationFullLabel(HUMBOLDT)).toBe('Humboldt Park, Chicago, Illinois, US');
	});

	it('does not trim a name a card would have shortened', () => {
		const name = 'Peace Portal Drive, Blaine, Whatcom County, Washington, 98231, United States';
		expect(locationFullLabel([{ $type: ADDRESS, name, country: 'US' }])).toBe(`${name}, US`);
	});

	it('shows the point for a record saved as bare coordinates', () => {
		expect(locationFullLabel([{ $type: GEO, latitude: '41.9027884', longitude: '-87.7209107' }])).toBe(
			'41.90279, -87.72091'
		);
	});

	it('shows nothing when there is no entry kind it can read', () => {
		expect(locationFullLabel([])).toBeUndefined();
		expect(locationFullLabel([{ $type: 'community.lexicon.location.h3' }])).toBeUndefined();
	});
});

describe('a name that already states its own context', () => {
	// Records from other clients often carry a whole reverse-geocoded string in
	// `name`, so appending the address fields back onto it repeats them.
	const CAFE = [
		{ $type: ADDRESS, name: 'Cafe, Paris', locality: 'Paris', region: 'IDF', country: 'FR' }
	];

	it('does not repeat a locality the name already carries', () => {
		expect(locationShortLabel(CAFE)).toBe('Cafe, Paris, IDF');
	});

	it('does not repeat it in the full label either', () => {
		expect(locationFullLabel(CAFE)).toBe('Cafe, Paris, IDF, FR');
	});

	it('drops a street that merely restates the name', () => {
		// A named road feature stores the name and the street as the same string.
		expect(
			locationFullLabel([
				{
					$type: ADDRESS,
					name: 'Indianapolis Motor Speedway',
					street: 'Indianapolis Motor Speedway',
					locality: 'Speedway',
					region: 'Indiana',
					country: 'US'
				}
			])
		).toBe('Indianapolis Motor Speedway, Speedway, Indiana, US');
	});

	it('matches whole segments, not substrings', () => {
		// "Paris" appears inside "Paris Street" but is not that segment, so the
		// locality is still worth showing.
		expect(
			locationShortLabel([{ $type: ADDRESS, name: 'Paris Street Cafe', locality: 'Paris', country: 'FR' }])
		).toBe('Paris Street Cafe, Paris');
	});
});

describe('formatPoint rejects a point it would be wrong to state', () => {
	it('rejects coordinates outside WGS84', () => {
		// Lexicon-valid but unusable: the editor and the search normalizer both
		// reject this, so displaying it would assert a position that cannot exist.
		expect(formatPoint('91', '181')).toBe('');
		expect(formatPoint('-91', '0')).toBe('');
		expect(formatPoint('0', '-181')).toBe('');
		expect(
			locationFullLabel([{ $type: GEO, latitude: '91', longitude: '181' }])
		).toBeUndefined();
	});

	it('rejects blank and whitespace-only coordinates', () => {
		// Number('   ') is 0, which would render Null Island as a real location.
		expect(formatPoint('   ', '   ')).toBe('');
		expect(formatPoint('', '')).toBe('');
	});

	it('still accepts the extremes of the valid range', () => {
		expect(formatPoint('90', '180')).toBe('90.00000, 180.00000');
		// Either axis alone at zero is a real place — the equator and the prime
		// meridian both run through inhabited land. Only the pair is the sentinel.
		expect(formatPoint('0', '12.56891')).toBe('0.00000, 12.56891');
		expect(formatPoint('55.67606', '0')).toBe('55.67606, 0.00000');
	});

	it('rejects the 0,0 sentinel', () => {
		// Valid WGS84 and open ocean, so it is the conventional "no data" value rather
		// than a place: a record carries it when nobody could geocode the pick. This is
		// the last-resort label, so rejecting it renders no location at all — correct,
		// because such a record HAS no position. It also keeps the label out of the map
		// link, which falls back to querying the label text when it has no point.
		expect(formatPoint('0', '0')).toBe('');
		expect(formatPoint('0.0', '-0')).toBe('');
		expect(locationFullLabel([{ $type: GEO, latitude: '0', longitude: '0' }])).toBeUndefined();
		expect(locationShortLabel([{ $type: GEO, latitude: '0', longitude: '0' }])).toBeUndefined();
	});

	it('still shows the address when a sentinel point sits beside it', () => {
		// The sentinel only costs the record its POINT. Records carrying 0,0 next to a
		// good address are live on atmo, and the address is what they are for.
		expect(
			locationFullLabel([
				{ $type: ADDRESS, locality: 'Albuquerque', country: 'US' },
				{ $type: GEO, latitude: '0', longitude: '0' }
			])
		).toBe('Albuquerque, US');
	});
});

describe('a city-state, where locality and region are the same place', () => {
	// Both of these are live on atmo today. The repetition predates the place-name
	// work — the card always joined locality and region blindly — but leading with
	// a name made it more visible, so the labels drop it now.
	it('shows the place once when locality equals region', () => {
		expect(
			locationShortLabel([{ $type: ADDRESS, locality: 'Zürich', region: 'Zürich', country: 'CH' }])
		).toBe('Zürich');
	});

	it('does the same after a place name', () => {
		expect(
			locationShortLabel([
				{ $type: ADDRESS, name: '@c-base.org', locality: 'Berlin', region: 'Berlin', country: 'DE' }
			])
		).toBe('@c-base.org, Berlin');
	});

	it('does the same in the full label', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, name: '@c-base.org', locality: 'Berlin', region: 'Berlin', country: 'DE' }
			])
		).toBe('@c-base.org, Berlin, DE');
	});

	it('is case-insensitive about it', () => {
		expect(
			locationShortLabel([{ $type: ADDRESS, locality: 'berlin', region: 'Berlin', country: 'DE' }])
		).toBe('berlin');
	});
});

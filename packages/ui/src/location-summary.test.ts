import { describe, expect, it } from 'vitest';
import {
	formatPoint,
	leadingPlaceName,
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

describe('leadingPlaceName', () => {
	// Names taken verbatim from records already in the index. The ones carrying a
	// place name and no address were written by other clients and hold a whole
	// reverse-geocoded string.
	it('takes the first segment of a reverse-geocoded string', () => {
		expect(
			leadingPlaceName('Soundbreathe, Rear 6, Charles Road, Hoylake, Wirral, UK')
		).toBe('Soundbreathe');
		expect(
			leadingPlaceName('Peace Portal Drive, Blaine, Whatcom County, Washington, 98231, United States')
		).toBe('Peace Portal Drive');
		expect(
			leadingPlaceName('Funkhaus Berlin, Oberschöneweide, Treptow-Köpenick, Berlin, 12459, Germany')
		).toBe('Funkhaus Berlin');
		expect(
			leadingPlaceName(
				'Beaverdell, Area E (Beaverdell/West Boundary), Regional District of Kootenay Boundary, British Columbia, Canada'
			)
		).toBe('Beaverdell');
	});

	it('leaves a name that is already one segment', () => {
		for (const name of [
			'Humboldt Park',
			'Hive76',
			'The Sanctuary &Soul | Sauna & Wellness Studio',
			'The Really Very Long Name Of One Single Place With No Commas At All'
		]) {
			expect(leadingPlaceName(name)).toBe(name);
		}
	});

	it('does not cut a word to fit — there is no length budget', () => {
		// Eliding a label to the width available is the READER's job, in CSS, where
		// the real width is known. A budget here has to pick a segment to end on, and
		// every rule for that misclassifies some real name.
		const name = 'The Sanctuary &Soul | Sauna & Wellness Studio';
		expect(leadingPlaceName(name)).toBe(name);
		expect(leadingPlaceName('1100 Louisiana Blvd SE, Albuquerque, NM 87108')).toBe(
			'1100 Louisiana Blvd SE'
		);
	});
});

describe('leadingPlaceName — a first segment that names nothing', () => {
	// 93 of the 3,977 records this path serves lead with a unit or house number.
	// Cutting to that alone leaves "Plot 9", which reads as the place's NAME rather
	// than as a truncation — so it runs on to the first segment that names something.
	it('runs on past a leading unit or house number', () => {
		expect(leadingPlaceName('Plot 9, Restell Close, London, UK')).toBe('Plot 9, Restell Close');
		expect(leadingPlaceName('21 SID, Sidworth Street, London, UK')).toBe('21 SID, Sidworth Street');
		expect(leadingPlaceName('Studio 1, OMUK, 22 Pakenham Street, London, UK')).toBe(
			'Studio 1, OMUK'
		);
		expect(leadingPlaceName('Studio 6, Dartington')).toBe('Studio 6, Dartington');
		expect(
			leadingPlaceName(
				'1551, Southeast Poplar Avenue, Ladd’s Addition, Portland, Oregon, United States'
			)
		).toBe('1551, Southeast Poplar Avenue');
	});

	it('runs on past a leading postcode', () => {
		// A house-number suffix ("12A", "221B") and most postcodes carry a letter, so
		// "does it contain a letter" is not enough to tell a code from a name.
		expect(leadingPlaceName('SW1A 1AA, Baker Street, London, UK')).toBe('SW1A 1AA, Baker Street');
		expect(leadingPlaceName('221B, Baker Street, London, UK')).toBe('221B, Baker Street');
	});

	it('runs on past SEVERAL code-only segments', () => {
		// The decision is per segment, never on the joined label: "12A, 60651" clears
		// the length bound between them and would otherwise read as a place name.
		expect(leadingPlaceName('12A, 60651, Cortez Street, Chicago, US')).toBe(
			'12A, 60651, Cortez Street'
		);
	});

	it('reads a house number written in any script', () => {
		// \p{Nd}, not \d — Arabic-Indic digits are digits.
		expect(leadingPlaceName('۱۲A, Boulevard Saint-Germain, Paris, France')).toBe(
			'۱۲A, Boulevard Saint-Germain'
		);
	});

	it('does not mistake a place named with a digit for a code', () => {
		// Long enough to read as a name, so it stands on its own and nothing runs on.
		expect(leadingPlaceName('1100 Louisiana Blvd SE, Albuquerque')).toBe('1100 Louisiana Blvd SE');
	});

	it('keeps a place genuinely named after a number', () => {
		// Nothing to run on to, so the code stands — correct, because a name with no
		// other segment is all the record has.
		expect(leadingPlaceName('1919')).toBe('1919');
		expect(leadingPlaceName('12A, 60651')).toBe('12A, 60651');
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
	// A card answers "is this near me?", so it shows the town — the same label a card
	// showed before this module existed. The venue name is on the event page.
	it('shows the locality and region, not the venue name', () => {
		expect(locationShortLabel(HUMBOLDT)).toBe('Chicago, Illinois');
	});

	it('shows the same label whether or not the pick has a name', () => {
		// The name changes what is SAVED and what the event page shows. It must not
		// change the card for a record that already had a card label.
		const withName = locationShortLabel([
			{ $type: ADDRESS, name: 'Cafe Rustica', locality: 'Boston', region: 'MA', country: 'US' }
		]);
		const withoutName = locationShortLabel([
			{ $type: ADDRESS, locality: 'Boston', region: 'MA', country: 'US' }
		]);
		expect(withName).toBe('Boston, MA');
		expect(withoutName).toBe('Boston, MA');
	});

	it('is not shortened when the locality and region are long', () => {
		// No budget: a card that cannot fit this elides it in CSS.
		expect(
			locationShortLabel([
				{ $type: ADDRESS, locality: 'Kailua-Kona', region: 'Hawaii', country: 'US' }
			])
		).toBe('Kailua-Kona, Hawaii');
	});

	it('falls back to the name when the record has NO locality or region', () => {
		// The case a card used to render blank: a pick the geocoder gave no ISO country
		// code for is saved as a geo entry alone. 3,977 of 5,022 records in the corpus.
		expect(
			locationShortLabel([
				{ $type: GEO, name: 'Humboldt Park', latitude: '41.9027884', longitude: '-87.7209107' }
			])
		).toBe('Humboldt Park');
	});

	it('leads that fallback name rather than showing a whole address', () => {
		expect(
			locationShortLabel([
				{
					$type: GEO,
					name: 'Soundbreathe, Rear 6, Charles Road, Hoylake, Wirral, UK',
					latitude: '53.3911435',
					longitude: '-3.1787171'
				}
			])
		).toBe('Soundbreathe');
	});

	it('prefers even a bare region to the name', () => {
		// Half the context is still the answer to "where is this?"; the name is not.
		expect(
			locationShortLabel([{ $type: ADDRESS, name: 'Sisyphos', region: 'Berlin', country: 'DE' }])
		).toBe('Berlin');
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
		expect(locationFullLabel(CAFE)).toBe('Cafe, Paris, IDF, FR');
	});

	it('does not arise on a card, which never shows the name beside the fields', () => {
		expect(locationShortLabel(CAFE)).toBe('Paris, IDF');
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
			locationFullLabel([{ $type: ADDRESS, name: 'Paris Street Cafe', locality: 'Paris', country: 'FR' }])
		).toBe('Paris Street Cafe, Paris, FR');
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

describe('a city that shares its state, province or canton name', () => {
	// Not a repetition to collapse. "New York, New York" is how that city is
	// written, and "New York" alone could be either the city or the state, so
	// dropping half makes the place MORE ambiguous. Every record in the corpus
	// where locality equals region is this pattern — Wien, Québec, Zürich,
	// Luzern, Berlin — so the fields are never de-duplicated against each other.
	it('keeps both when locality equals region', () => {
		expect(
			locationShortLabel([
				{ $type: ADDRESS, locality: 'New York', region: 'New York', country: 'US' }
			])
		).toBe('New York, New York');
	});

	it('keeps both on a card that also has a place name to ignore', () => {
		expect(
			locationShortLabel([
				{ $type: ADDRESS, name: '@c-base.org', locality: 'Berlin', region: 'Berlin', country: 'DE' }
			])
		).toBe('Berlin, Berlin');
	});

	it('keeps both in the full label, which leads with the name and carries the country', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, name: '@c-base.org', locality: 'Berlin', region: 'Berlin', country: 'DE' }
			])
		).toBe('@c-base.org, Berlin, Berlin, DE');
	});

	// The name is still de-duplicated against the fields in the FULL label — that
	// repetition is real, and it is the case the shared module exists for.
	it('still drops a field the NAME already states', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, name: 'Zürich', locality: 'Zürich', region: 'Zürich', country: 'CH' }
			])
		).toBe('Zürich, CH');
	});
});

describe('a name written by another client, tidied before anything reads it', () => {
	// Geocoders emit a feature's own name again as the next segment when the feature
	// and its street or area share a name, and they emit empty segments and stray
	// double spaces. Both used to render verbatim in the full label.
	it('collapses a segment repeated immediately after itself', () => {
		expect(
			locationFullLabel([
				{ $type: GEO, latitude: '51.8', longitude: '-3.0', name: 'Three Pools, Three Pools, Llanvetherine, Abergavenny, UK' }
			])
		).toBe('Three Pools, Llanvetherine, Abergavenny, UK');
	});

	it('drops empty segments and tidies the spacing around them', () => {
		expect(
			locationFullLabel([
				{ $type: GEO, latitude: '51.5', longitude: '-2.5', name: '58th Bristol Scout Group,, Gadshill Road,  Bristol' }
			])
		).toBe('58th Bristol Scout Group, Gadshill Road, Bristol');
	});

	it('leaves a segment that recurs further along, which is not a geocoder artefact', () => {
		expect(
			locationFullLabel([
				{ $type: GEO, latitude: '51.5', longitude: '-2.5', name: 'Bristol, Hereford Street, Bristol' }
			])
		).toBe('Bristol, Hereford Street, Bristol');
	});
});

describe('a place carrying its postal code in the same segment', () => {
	// Whole-segment matching cannot see that "CO 80123" states the region "CO", so
	// the region was appended a second time, after the country.
	it('recognises the region and does not append it again', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, street: '4237 W. Grand Ave.', locality: 'Littleton', region: 'CO', country: 'US' },
				{
					$type: GEO,
					latitude: '39.6300995',
					longitude: '-105.0412264',
					name: '4237 W. Grand Ave., Littleton, CO 80123, US'
				}
			])
		).toBe('4237 W. Grand Ave., Littleton, CO 80123, US');
	});

	it('recognises a UK locality ahead of its postcode', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, locality: 'Bristol', country: 'UK', name: 'The Chapel, Cote Lane, Bristol BS9 2UN' }
			])
		).toBe('The Chapel, Cote Lane, Bristol BS9 2UN, UK');
	});

	// The code itself is never removed from what is shown: a calendar app wants it.
	it('keeps the postal code in the rendered label', () => {
		expect(
			locationFullLabel([
				{ $type: ADDRESS, locality: 'London', country: 'UK', name: 'Soma, 231 Church St, London N16 9HP' }
			])
		).toContain('N16 9HP');
	});
});

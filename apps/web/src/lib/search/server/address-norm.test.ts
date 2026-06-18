// apps/web/src/lib/search/server/address-norm.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeAddress, addressLocation, ADDRESS_TYPE } from './address-norm';

describe('normalizeAddress', () => {
	it('joins all present fields in fixed order with | separators', () => {
		const key = normalizeAddress({
			country: 'US',
			locality: 'Dayton',
			street: '905 East 3rd Street',
			region: 'Ohio',
			postalCode: '45402',
			name: 'The Venue'
		});
		// fixed order: name, street, locality, region, postalCode, country
		expect(key).toBe('the venue|905 east 3rd street|dayton|ohio|45402|us');
	});

	it('omits absent/empty fields entirely', () => {
		expect(normalizeAddress({ locality: 'Dayton', country: 'US' })).toBe('dayton|us');
	});

	it('lowercases, NFC-normalizes, collapses whitespace, trims edge punctuation', () => {
		expect(normalizeAddress({ locality: 'Dayton,', region: '  Ohio   State ' })).toBe(
			'dayton|ohio state'
		);
	});

	it('strips the separator char from field content', () => {
		expect(normalizeAddress({ name: 'A|B', country: 'US' })).toBe('a b|us');
	});

	it('returns null when nothing is present', () => {
		expect(normalizeAddress({})).toBeNull();
		expect(normalizeAddress({ country: '   ' })).toBeNull();
	});

	it('produces an identical key regardless of field insertion order', () => {
		const a = normalizeAddress({ country: 'US', locality: 'Dayton' });
		const b = normalizeAddress({ locality: 'Dayton', country: 'US' });
		expect(a).toBe(b);
	});
});

describe('addressLocation', () => {
	it('returns the first .address location', () => {
		const loc = addressLocation({
			locations: [
				{ $type: 'community.lexicon.location.geo', latitude: '1', longitude: '2' },
				{ $type: ADDRESS_TYPE, locality: 'Dayton', country: 'US' }
			]
		});
		expect(loc).toMatchObject({ locality: 'Dayton', country: 'US' });
	});

	it('returns null when no address location is present', () => {
		expect(addressLocation({ locations: [{ $type: 'community.lexicon.location.geo' }] })).toBeNull();
		expect(addressLocation({})).toBeNull();
	});
});

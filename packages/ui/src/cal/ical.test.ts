import { describe, expect, it } from 'vitest';
import { generateICalEvent } from './ical';
import type { EventData } from '../event-types';

const BASE_EVENT: EventData = {
	createdAt: '2026-07-24T12:00:00Z',
	name: 'Location test',
	startsAt: '2026-08-01T18:00:00Z'
};

describe('generateICalEvent — location fallback', () => {
	it('emits an address name when no address fields are present', () => {
		const ical = generateICalEvent(
			{
				...BASE_EVENT,
				locations: [
					{
						$type: 'community.lexicon.location.address',
						name: 'France',
						country: 'FR'
					}
				]
			},
			'at://did:plc:test/community.lexicon.calendar.event/address-name'
		);

		expect(ical).toContain('LOCATION:France\r\n');
	});

	it('emits a geo name when no address entry is present', () => {
		const ical = generateICalEvent(
			{
				...BASE_EVENT,
				locations: [
					{
						$type: 'community.lexicon.location.geo',
						name: 'Humboldt Park',
						latitude: '41.9027884',
						longitude: '-87.7209107'
					}
				]
			},
			'at://did:plc:test/community.lexicon.calendar.event/geo-name'
		);

		expect(ical).toContain('LOCATION:Humboldt Park\r\n');
	});
});

import { describe, expect, it } from 'vitest';
import {
	EVENT_COLLECTION,
	eventPath,
	eventSpace,
	eventUri,
	privateEventPath,
	privateEventUri,
	singleEvent
} from './ids';

const HOST = 'did:plc:hosthosthosthosthosthost';

describe('where a private event is', () => {
	it('keeps a single event in a space of its own, under the event’s key', () => {
		const event = singleEvent(HOST, '3lzzzzzzzzzzz');
		expect(eventSpace(event)).toBe(`at://${HOST}/space/rsvp.atmo.dev.space/3lzzzzzzzzzzz`);
		expect(eventUri(event)).toBe(
			`at://${HOST}/space/rsvp.atmo.dev.space/3lzzzzzzzzzzz/${HOST}/${EVENT_COLLECTION}/3lzzzzzzzzzzz`
		);
		expect(privateEventUri(HOST, '3lzzzzzzzzzzz')).toBe(eventUri(event));
	});

	it('gives a single event the page it always had', () => {
		expect(privateEventPath('host.example.com', '3lzzzzzzzzzzz')).toBe(
			'/p/host.example.com/private/3lzzzzzzzzzzz'
		);
		expect(eventPath('host.example.com', singleEvent(HOST, '3lzzzzzzzzzzz'))).toBe(
			'/p/host.example.com/private/3lzzzzzzzzzzz'
		);
	});

	it('keeps the two keys apart for an event in a shared space', () => {
		const event = { host: HOST, spaceKey: 'shared', rkey: '3lzzzzzzzzzzz' };
		expect(eventSpace(event)).toBe(`at://${HOST}/space/rsvp.atmo.dev.space/shared`);
		expect(eventUri(event)).toBe(
			`at://${HOST}/space/rsvp.atmo.dev.space/shared/${HOST}/${EVENT_COLLECTION}/3lzzzzzzzzzzz`
		);
		expect(eventPath('host.example.com', event)).toBe(
			'/p/host.example.com/calendar/shared/3lzzzzzzzzzzz'
		);
	});
});

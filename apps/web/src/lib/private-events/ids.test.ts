import { describe, expect, it } from 'vitest';
import {
	EVENT_COLLECTION,
	eventPath,
	eventSpace,
	eventUri,
	isSpaceKey,
	privateEventPath,
	singleEvent
} from './ids';

const HOST = 'did:plc:hosthosthosthosthosthost';

describe('where a private event is', () => {
	it('keeps a single event in a space of its own, under the event’s key', () => {
		const event = singleEvent(HOST, '3lzzzzzzzzzzz');
		expect(eventSpace(event)).toBe(
			`at://${HOST}/space/community.lexicon.calendar.collection/3lzzzzzzzzzzz`
		);
		expect(eventUri(event)).toBe(
			`at://${HOST}/space/community.lexicon.calendar.collection/3lzzzzzzzzzzz/${HOST}/${EVENT_COLLECTION}/3lzzzzzzzzzzz`
		);
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
		expect(eventSpace(event)).toBe(
			`at://${HOST}/space/community.lexicon.calendar.collection/shared`
		);
		expect(eventUri(event)).toBe(
			`at://${HOST}/space/community.lexicon.calendar.collection/shared/${HOST}/${EVENT_COLLECTION}/3lzzzzzzzzzzz`
		);
		expect(eventPath('host.example.com', event)).toBe(
			'/p/host.example.com/calendar/shared/3lzzzzzzzzzzz'
		);
	});
});

describe('a private space’s key, as a page may send it', () => {
	it.each(['3lzzzzzzzzzzz', 'cal-3lzzzzzzzzzzz', 'shared-space', 'a.b_c:d~e'])(
		'takes %s, whatever kind of space it is',
		(key) => expect(isSpaceKey(key)).toBe(true)
	);

	it.each(['', 'has space', 'slash/in/it', 'at://did:plc:x', 'x'.repeat(513), 'ümlaut'])(
		'refuses %j',
		(key) => expect(isSpaceKey(key)).toBe(false)
	);
});

import { describe, expect, it } from 'vitest';
import type { FlatEventRecord } from '#lib/contrail.js';
import type { MyPrivateEvent } from './server/events';
import { withPrivateEvents } from './your-events';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const CUTOFF = NOW - 7 * 86400000;
const at = (days: number) => new Date(NOW + days * 86400000).toISOString();

const event = (name: string, days: number): FlatEventRecord =>
	({
		uri: `at://did:plc:someone/${name}`,
		did: 'did:plc:someone',
		rkey: name,
		name,
		startsAt: at(days),
		createdAt: at(-30)
	}) as FlatEventRecord;

const privateOne = (
	name: string,
	days: number,
	calendar?: { name: string | null; key: string }
): MyPrivateEvent => ({
	event: event(name, days),
	hosting: false,
	hostHandle: 'host.example.com',
	href: `/p/host.example.com/private/${name}`,
	...(calendar ? { calendar } : {})
});

describe('your private events in Your events', () => {
	it('puts them among the public ones by date: upcoming soonest first, past latest first', () => {
		const mine = { upcoming: [event('pub-2', 2), event('pub-5', 5)], past: [event('pub-was', -2)] };
		const merged = withPrivateEvents(
			mine,
			[privateOne('priv-1', 1), privateOne('priv-3', 3), privateOne('priv-was', -1)],
			NOW,
			CUTOFF
		);
		expect(merged.upcoming.map((e) => e.name)).toEqual(['priv-1', 'pub-2', 'priv-3', 'pub-5']);
		expect(merged.past.map((e) => e.name)).toEqual(['priv-was', 'pub-was']);
	});

	it('links each private one to its own page, never to a public event page', () => {
		const merged = withPrivateEvents(
			{ upcoming: [], past: [] },
			[privateOne('priv-1', 1)],
			NOW,
			CUTOFF
		);
		expect(merged.privateLinks).toEqual({
			'at://did:plc:someone/priv-1': {
				href: '/p/host.example.com/private/priv-1',
				calendar: null
			}
		});
	});

	it('names the shared calendar an event is on, or calls it untitled', () => {
		const merged = withPrivateEvents(
			{ upcoming: [], past: [] },
			[
				privateOne('on-supper', 1, { name: 'Supper club', key: 'cal-3l1' }),
				privateOne('on-unnamed', 2, { name: null, key: 'cal-3l2' })
			],
			NOW,
			CUTOFF
		);
		expect(merged.privateLinks['at://did:plc:someone/on-supper'].calendar).toBe('Supper club');
		expect(merged.privateLinks['at://did:plc:someone/on-unnamed'].calendar).toBe(
			'Untitled calendar'
		);
	});

	it('leaves out one that ended before the cutoff, as the public list does', () => {
		const merged = withPrivateEvents(
			{ upcoming: [], past: [] },
			[privateOne('long-ago', -30)],
			NOW,
			CUTOFF
		);
		expect(merged.past).toEqual([]);
		expect(merged.privateLinks).toEqual({});
	});

	it('changes nothing about the public ones when there are no private ones', () => {
		const mine = { upcoming: [event('pub-2', 2)], past: [event('pub-was', -2)] };
		const merged = withPrivateEvents(mine, [], NOW, CUTOFF);
		expect(merged).toEqual({ ...mine, privateLinks: {} });
	});
});

import { describe, expect, it } from 'vitest';
import { scheduleGroupEvents } from './event-schedule';
import type { GroupEventRecord } from './types';

const NOW = '2026-10-26T18:00:00.000Z';

const at = (rkey: string, startsAt?: string, endsAt?: string): GroupEventRecord => ({
	uri: `at://did:plc:group/community.lexicon.calendar.event/${rkey}`,
	cid: 'c',
	rkey,
	value: { name: rkey, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt } : {}) }
});

const rkeys = (events: GroupEventRecord[]) => events.map((e) => e.rkey);

describe('scheduleGroupEvents', () => {
	it('lists what is to come soonest first and what is over most recent first', () => {
		const { upcoming, past } = scheduleGroupEvents(
			[
				at('hill', '2026-10-25T18:00:00Z'),
				at('tenk', '2026-10-01T08:00:00Z'),
				at('trail', '2026-11-03T09:00:00Z'),
				at('long', '2026-10-27T08:00:00Z')
			],
			NOW
		);
		expect(rkeys(upcoming)).toEqual(['long', 'trail']);
		expect(rkeys(past)).toEqual(['hill', 'tenk']);
	});

	it('keeps an event under way with what is to come, ahead of the rest', () => {
		const { upcoming, past } = scheduleGroupEvents(
			[
				at('later', '2026-10-27T08:00:00Z'),
				at('now', '2026-10-26T17:00:00Z', '2026-10-26T20:00:00Z')
			],
			NOW
		);
		expect(rkeys(upcoming)).toEqual(['now', 'later']);
		expect(past).toEqual([]);
	});

	it('counts an event with no end as over once it has started', () => {
		const { upcoming, past } = scheduleGroupEvents([at('started', '2026-10-26T17:59:00Z')], NOW);
		expect(upcoming).toEqual([]);
		expect(rkeys(past)).toEqual(['started']);
	});

	it('puts an event with no start, or one that does not parse, at the end of the past', () => {
		const { upcoming, past } = scheduleGroupEvents(
			[at('undated'), at('garbled', 'next tuesday'), at('tenk', '2026-10-01T08:00:00Z')],
			NOW
		);
		expect(upcoming).toEqual([]);
		expect(rkeys(past)).toEqual(['tenk', 'garbled', 'undated']);
	});

	it('breaks a tie on the same start by URI, so the order never shifts between loads', () => {
		const same = '2026-11-01T10:00:00Z';
		const { upcoming } = scheduleGroupEvents([at('b', same), at('a', same)], NOW);
		expect(rkeys(upcoming)).toEqual(['a', 'b']);
	});
});

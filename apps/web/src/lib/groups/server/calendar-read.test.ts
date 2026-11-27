import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CALENDAR,
	calendarHosts,
	event,
	fakeCalendar,
	GROUP,
	READY_POLICY
} from './__fixtures__/group-calendar';

const mocks = vi.hoisted(() => ({ networkFetch: vi.fn<typeof fetch>() }));
vi.mock('#lib/atproto/network.js', () => ({
	atprotoNetwork: () => ({
		fetch: (input: RequestInfo | URL, init?: RequestInit) => mocks.networkFetch(input, init),
		isolated: false,
		assertUrl: () => {}
	})
}));

import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import {
	listMembersOnlyEvents,
	MEMBERS_ONLY_LIST_LIMIT,
	readMembersOnlyEvent,
	readOwnRsvp,
	upcoming
} from './calendar-read';

const BOB = 'did:plc:bob';
let calendar: ReturnType<typeof fakeCalendar>;
const bob = () => ({ handle: calendar.personHandle(BOB) });

beforeEach(() => {
	vi.resetAllMocks();
	calendar = fakeCalendar();
	calendar.state.policy = READY_POLICY;
	mocks.networkFetch.mockImplementation(calendar.fetch);
});

describe("a group's members-only events", () => {
	it('are listed for someone the host lets read the space, with no picture of any kind', async () => {
		calendar.state.readers.add(BOB);
		calendar.state.events.set('r1', {
			...event('Supper'),
			poster: 'https://elsewhere.example/p.png',
			media: [{ image: 'x' }],
			uris: [{ uri: 'https://elsewhere.example/i.png', name: 'Event Image' }]
		});
		calendar.state.events.set('r2', { name: 'Not an event' });
		const list = await listMembersOnlyEvents(bob(), GROUP, calendarHosts);
		expect(list).toEqual({
			events: [
				expect.objectContaining({
					name: 'Supper',
					rkey: 'r1',
					did: GROUP,
					uri: `${CALENDAR}/${GROUP}/community.lexicon.calendar.event/r1`,
					uris: []
				})
			],
			cutOff: false
		});
		expect(list?.events[0]).not.toHaveProperty('poster');
		expect(list?.events[0]).not.toHaveProperty('media');
		// The member's own PDS signs the delegation for the group's calendar space.
		expect(calendar.state.sent).toEqual([
			[BOB, 'com.atproto.space.getDelegationToken', { space: CALENDAR }]
		]);
	});

	it('are null for someone the host keeps out, and while there is no space, alike', async () => {
		calendar.state.events.set('r1', event('Supper'));
		expect(await listMembersOnlyEvents(bob(), GROUP, calendarHosts)).toBeNull();
		calendar.state.readers.add(BOB);
		calendar.state.policy = null;
		expect(await listMembersOnlyEvents(bob(), GROUP, calendarHosts)).toBeNull();
	});

	it('say so when they stop at the limit with more to read, rather than stopping quietly', async () => {
		calendar.state.readers.add(BOB);
		let page = 0;
		mocks.networkFetch.mockImplementation(async (input, init) => {
			if (!String(input).includes('listRecords')) return calendar.fetch(input, init);
			page++;
			const records = Array.from({ length: 100 }, (_, i) => ({
				collection: 'community.lexicon.calendar.event',
				rkey: `p${page}r${i}`,
				cid: 'c',
				value: event(`Event ${page}.${i}`)
			}));
			return Response.json({ records, cursor: `after-${page}` });
		});
		const list = await listMembersOnlyEvents(bob(), GROUP, calendarHosts);
		expect(page).toBe(MEMBERS_ONLY_LIST_LIMIT / 100);
		expect(list?.events).toHaveLength(MEMBERS_ONLY_LIST_LIMIT);
		expect(list?.cutOff).toBe(true);
		expect(MEMBERS_ONLY_LIST_LIMIT).toBe(500);
	});

	it('throw in an outage, rather than read as none', async () => {
		calendar.state.readers.add(BOB);
		mocks.networkFetch.mockImplementation(async (input, init) =>
			String(input).includes('listRecords')
				? new Response('', { status: 502 })
				: calendar.fetch(input, init)
		);
		await expect(listMembersOnlyEvents(bob(), GROUP, calendarHosts)).rejects.toThrow();
	});

	it('are read one at a time with a checked MAC, and null for a reader kept out', async () => {
		calendar.state.events.set('r1', event('Supper'));
		calendar.state.readers.add(BOB);
		const reader = () => credentialSpaceReader(bob(), calendarHosts);
		expect(await readMembersOnlyEvent(reader(), GROUP, 'r1')).toMatchObject({ name: 'Supper' });
		expect(await readMembersOnlyEvent(reader(), GROUP, 'nope')).toBeNull();
		calendar.state.readers.clear();
		expect(await readMembersOnlyEvent(reader(), GROUP, 'r1')).toBeNull();
	});

	it("read a member's own RSVP only when it answers this event", async () => {
		calendar.state.readers.add(BOB);
		const rsvp = (uri: string) => ({
			$type: 'community.lexicon.calendar.rsvp',
			status: 'community.lexicon.calendar.rsvp#going',
			subject: { uri, cid: 'c' },
			createdAt: '2026-11-01T00:00:00.000Z'
		});
		const reader = () => credentialSpaceReader(bob(), calendarHosts);
		calendar.state.rsvps.set(
			`${BOB}/r1`,
			rsvp(`${CALENDAR}/${GROUP}/community.lexicon.calendar.event/r1`)
		);
		expect(await readOwnRsvp(reader(), GROUP, BOB, 'r1')).toBe('going');
		calendar.state.rsvps.set(
			`${BOB}/r1`,
			rsvp(`at://${GROUP}/community.lexicon.calendar.event/r1`)
		);
		expect(await readOwnRsvp(reader(), GROUP, BOB, 'r1')).toBeNull();
	});

	it('keep only those not over yet, soonest first', () => {
		const at = (rkey: string, startsAt: string) => ({ rkey, startsAt }) as never;
		const now = Date.parse('2026-06-01T00:00:00Z');
		expect(
			upcoming(
				[
					at('late', '2026-09-01T00:00:00Z'),
					at('past', '2026-01-01T00:00:00Z'),
					at('soon', '2026-07-01T00:00:00Z')
				],
				now
			).map((e: { rkey: string }) => e.rkey)
		).toEqual(['soon', 'late']);
	});
});

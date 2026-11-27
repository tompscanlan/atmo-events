import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { memoryKV } from './__fixtures__/kv';
import {
	CALENDAR,
	calendarAt,
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
	Object.assign(env, { OAUTH_SESSIONS: memoryKV() });
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
			cutOff: false,
			privacy: 'private'
		});
		expect(list?.events[0]).not.toHaveProperty('poster');
		expect(list?.events[0]).not.toHaveProperty('media');
		// The member's own PDS signs the delegation for the group's calendar space.
		expect(calendar.state.sent).toEqual([
			[BOB, 'com.atproto.space.getDelegationToken', { space: CALENDAR }]
		]);
	});

	it('say their calendar is no longer for members alone once anyone may read it, as read now', async () => {
		calendar.state.readers.add(BOB);
		calendar.state.events.set('r1', event('Supper'));
		calendar.state.policy = { ...READY_POLICY, publicRead: true };
		expect((await listMembersOnlyEvents(bob(), GROUP, calendarHosts))?.privacy).toBe('public');
		// A policy of a kind this site does not read may let anyone read it.
		calendar.state.policy = { $type: 'com.example.policy' };
		expect((await listMembersOnlyEvents(bob(), GROUP, calendarHosts))?.privacy).toBe('public');
	});

	it("are listed, but not as members-only, when their calendar's policy could not be read", async () => {
		vi.spyOn(console, 'info').mockImplementation(() => {});
		calendar.state.readers.add(BOB);
		calendar.state.events.set('r1', event('Supper'));
		mocks.networkFetch.mockImplementation(async (input, init) =>
			String(input).includes('com.atproto.space.policy')
				? new Response('', { status: 502 })
				: calendar.fetch(input, init)
		);
		const list = await listMembersOnlyEvents(bob(), GROUP, calendarHosts);
		expect(list?.events).toHaveLength(1);
		expect(list?.privacy).toBe('unknown');
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

	it('are read one at a time, and null for one not there and a reader kept out alike', async () => {
		calendar.state.events.set('r1', event('Supper'));
		calendar.state.readers.add(BOB);
		const reader = () => credentialSpaceReader(bob(), calendarHosts);
		expect(await readMembersOnlyEvent(reader(), GROUP, 'r1', CALENDAR)).toMatchObject({
			name: 'Supper'
		});
		expect(await readMembersOnlyEvent(reader(), GROUP, 'nope', CALENDAR)).toBeNull();
		calendar.state.readers.clear();
		expect(await readMembersOnlyEvent(reader(), GROUP, 'r1', CALENDAR)).toBeNull();
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
		expect(await readOwnRsvp(reader(), GROUP, BOB, 'r1', CALENDAR)).toBe('going');
		calendar.state.rsvps.set(
			`${BOB}/r1`,
			rsvp(`at://${GROUP}/community.lexicon.calendar.event/r1`)
		);
		expect(await readOwnRsvp(reader(), GROUP, BOB, 'r1', CALENDAR)).toBeNull();
	});

	it("are read from the calendar the group uses, another app's, skipping all that is not a valid event of the group's", async () => {
		const WIKI = calendarAt('3lwikicalendar');
		const wiki = calendar.anotherAppsCalendar('3lwikicalendar', READY_POLICY);
		await env.OAUTH_SESSIONS.put(`group:calendar:${GROUP}`, WIKI);
		calendar.state.readers.add(BOB);
		calendar.state.events.set('mine', event('In self, not used'));
		wiki.events.set('w1', event('Wiki supper'));
		// What the other app writes there besides events, and events it wrote wrong.
		wiki.others.set('page1', {
			collection: 'com.example.wiki.page',
			value: { $type: 'com.example.wiki.page', title: 'Minutes', startsAt: '2099-01-01T00:00:00Z' }
		});
		wiki.events.set('w2', { $type: 'community.lexicon.calendar.event', name: 'No start' });
		wiki.events.set('w3', { ...event('Bad start'), startsAt: 7 });
		wiki.events.set('w4', { ...event('Bad mode'), mode: { not: 'a string' } });
		wiki.events.set('w5', { ...event('Not a record type'), $type: 'com.example.wiki.page' });
		const list = await listMembersOnlyEvents(bob(), GROUP, calendarHosts);
		expect(list?.events.map((e) => [e.rkey, e.uri])).toEqual([
			['w1', `${WIKI}/${GROUP}/community.lexicon.calendar.event/w1`]
		]);
		expect(calendar.state.sent).toEqual([
			[BOB, 'com.atproto.space.getDelegationToken', { space: WIKI }]
		]);
		const reader = () => credentialSpaceReader(bob(), calendarHosts);
		for (const rkey of ['w2', 'w3', 'w4', 'w5', 'page1']) {
			expect(await readMembersOnlyEvent(reader(), GROUP, rkey, WIKI)).toBeNull();
		}
	});

	it('keep only those not over yet, soonest first', () => {
		const at = (rkey: string, startsAt: string, endsAt?: string) =>
			({ rkey, startsAt, endsAt }) as never;
		const now = Date.parse('2026-06-01T00:00:00Z');
		expect(
			upcoming(
				[
					at('late', '2026-09-01T00:00:00Z'),
					at('past', '2026-01-01T00:00:00Z'),
					at('ended', '2026-05-01T00:00:00Z', '2026-05-02T00:00:00Z'),
					at('soon', '2026-07-01T00:00:00Z'),
					at('ongoing', '2026-05-01T00:00:00Z', '2026-06-02T00:00:00Z')
				],
				now
			).map((e: { rkey: string }) => e.rkey)
		).toEqual(['ongoing', 'soon', 'late']);
	});
});

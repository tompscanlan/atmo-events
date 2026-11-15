import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/contrail/index.js', () => ({
	getServerClient: vi.fn(() => ({ get: vi.fn(async () => ({ ok: false })) }))
}));
vi.mock('#lib/contrail.js', () => ({
	listDiscoverableEventsFromContrail: vi.fn(),
	listEventRecordsFromContrail: vi.fn(),
	getHostProfile: vi.fn(),
	buildAttendee: vi.fn(),
	flattenEventRecord: vi.fn((r: unknown) => r),
	flattenEventRecords: vi.fn((records: unknown[]) => records),
	withD1Retry: vi.fn((fn: () => unknown) => fn())
}));
// Keep a spy to guard against reintroducing the unused homepage query.
vi.mock('#lib/contrail/ongoing.js', () => ({ ongoingQuery: vi.fn() }));
vi.mock('#lib/server/edge-cache.js', () => ({
	cachedRead: vi.fn((_key: string, _ttl: number, fn: () => unknown) => fn())
}));
vi.mock('#lib/dedupe-by-uri.js', () => ({ dedupeByUri: vi.fn((e: unknown[]) => e) }));
// Private events: off unless a test turns them on.
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: vi.fn(() => false)
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: vi.fn(async () => null) }));
vi.mock('#lib/private-events/server/calendars.js', () => ({
	myPrivateEventsAndCalendars: vi.fn()
}));

import { load } from './+page.server';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';
import { myPrivateEventsAndCalendars } from '#lib/private-events/server/calendars.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsEnabled } from '#lib/private-events/server/enabled.js';
import { listDiscoverableEventsFromContrail } from '#lib/contrail.js';
import { ongoingQuery } from '#lib/contrail/ongoing.js';
import { cachedRead } from '#lib/server/edge-cache.js';

const mockDiscoverable = vi.mocked(listDiscoverableEventsFromContrail);

type LoadResult = {
	events: unknown[];
	handles: Record<string, string>;
	recentActivity: unknown[];
	myUpcoming: { name: string }[];
	myPast: unknown[];
	privateLinks: Record<string, { href: string; calendar: string | null }>;
	privateEventsIncomplete: boolean;
};

const event = {
	uri: 'at://a/1',
	did: 'did:plc:alice',
	rkey: '1',
	name: 'an event',
	startsAt: '2026-07-01T00:00:00Z',
	createdAt: '2026-06-01T00:00:00Z'
};
const request = () => ({ locals: {} }) as unknown as Parameters<typeof load>[0];

beforeEach(() => {
	vi.clearAllMocks();
	mockDiscoverable.mockResolvedValue({
		records: [event],
		profiles: [{ did: 'did:plc:alice', handle: 'alice.test' }]
	} as never);
});

describe('home page load', () => {
	it('returns popular upcoming events with host handles', async () => {
		const data = (await load(request())) as unknown as LoadResult;
		expect(data.events).toEqual([event]);
		expect(data.handles).toEqual({ 'did:plc:alice': 'alice.test' });
		expect(mockDiscoverable.mock.calls[0][1]).toMatchObject({
			rsvpsCountMin: 2,
			sort: 'startsAt',
			order: 'asc',
			limit: 20
		});
	});

	it('does not fetch, cache, or return a happening-now section on the homepage', async () => {
		const data = await load(request());
		expect(ongoingQuery).not.toHaveBeenCalled();
		expect(vi.mocked(cachedRead).mock.calls.map(([key]) => key)).not.toContain('home:ongoing');
		expect(data).not.toHaveProperty('ongoing');
		expect(data).not.toHaveProperty('ongoingTotal');
		expect(data).not.toHaveProperty('ongoingTotalIsFloor');
	});

	it('still returns the other homepage sections when discovery is unavailable', async () => {
		mockDiscoverable.mockResolvedValue(null as never);
		const data = (await load(request())) as unknown as LoadResult;
		expect(data.events).toEqual([]);
		expect(data.handles).toEqual({});
		expect(data.myUpcoming).toEqual([]);
		expect(data.myPast).toEqual([]);
		expect(data.recentActivity).toEqual([]);
		expect(ongoingQuery).not.toHaveBeenCalled();
	});
});

describe('your own private events in Your events', () => {
	const ME = 'did:plc:mememememememememememememe';
	const dinner = {
		uri: 'at://did:plc:host/space/rsvp.atmo.dev.space/3ldinner/did:plc:host/community.lexicon.calendar.event/3ldinner',
		did: 'did:plc:host',
		rkey: '3ldinner',
		name: 'Dinner',
		startsAt: new Date(Date.now() + 86400000).toISOString(),
		createdAt: '2026-11-01T00:00:00Z'
	};
	const signedIn = () => {
		const setHeaders = vi.fn();
		const event = { locals: { did: ME, session: {} }, setHeaders };
		return { event: event as unknown as Parameters<typeof load>[0], setHeaders };
	};
	const turnOn = () => {
		vi.mocked(privateEventsEnabled).mockReturnValue(true);
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: GUEST_SCOPE } as never);
		vi.mocked(myPrivateEventsAndCalendars).mockResolvedValue({
			events: [
				{
					event: dinner,
					hosting: false,
					hostHandle: 'host.example.com',
					href: '/p/host.example.com/calendar/cal-3lsupper/3ldinner',
					calendar: { name: 'Supper club', key: 'cal-3lsupper' }
				}
			],
			calendars: [],
			incomplete: false,
			capped: false
		} as never);
	};

	it('lists them with the public ones, linked to their own pages, and keeps the page from any cache', async () => {
		turnOn();
		const { event, setHeaders } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(data.myUpcoming.map((e) => e.name)).toEqual(['Dinner']);
		expect(data.privateLinks).toEqual({
			[dinner.uri]: {
				href: '/p/host.example.com/calendar/cal-3lsupper/3ldinner',
				calendar: 'Supper club'
			}
		});
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
	});

	it('lists them for a guest who allowed private events, whether or not they turned the beta on', async () => {
		// The beta is for hosting; a guest who answered from a host's link never needs it, and this is
		// the one place besides the link that brings them back to the event.
		turnOn();
		const { event } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(data.myUpcoming.map((e) => e.name)).toEqual(['Dinner']);
	});

	it('reads none with private events off', async () => {
		turnOn();
		vi.mocked(privateEventsEnabled).mockReturnValue(false);
		const { event } = signedIn();
		await load(event);
		expect(callerSession).not.toHaveBeenCalled();
		expect(myPrivateEventsAndCalendars).not.toHaveBeenCalled();
	});

	it('reads none without a grant to read them, and asks their server nothing', async () => {
		turnOn();
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: 'atproto' } as never);
		const { event, setHeaders } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(myPrivateEventsAndCalendars).not.toHaveBeenCalled();
		expect(data.privateEventsIncomplete).toBe(false);
		expect(setHeaders).not.toHaveBeenCalled();
	});

	it('asks their server nothing when the session can’t be read', async () => {
		turnOn();
		vi.mocked(callerSession).mockResolvedValue(null);
		const { event } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(myPrivateEventsAndCalendars).not.toHaveBeenCalled();
		expect(data.privateEventsIncomplete).toBe(false);
	});

	it.each([
		['some could not be read', { incomplete: true, capped: false }],
		['a calendar had more than were listed', { incomplete: false, capped: true }]
	])('says some may be missing when %s', async (_why, flags) => {
		turnOn();
		vi.mocked(myPrivateEventsAndCalendars).mockResolvedValue({
			events: [],
			calendars: [],
			...flags
		} as never);
		const { event, setHeaders } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(data.privateEventsIncomplete).toBe(true);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
	});

	it('shows the public ones alone when theirs could not be read', async () => {
		turnOn();
		vi.mocked(myPrivateEventsAndCalendars).mockRejectedValue(new Error('503'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { event, setHeaders } = signedIn();
		const data = (await load(event)) as unknown as LoadResult;
		expect(data.myUpcoming).toEqual([]);
		expect(data.privateLinks).toEqual({});
		expect(data.privateEventsIncomplete).toBe(true);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'private, no-store' });
	});

	it('does not wait more than a few seconds for their server', async () => {
		vi.useFakeTimers();
		try {
			turnOn();
			vi.mocked(myPrivateEventsAndCalendars).mockReturnValue(new Promise(() => {}));
			const { event } = signedIn();
			const loading = load(event);
			await vi.advanceTimersByTimeAsync(4000);
			const data = (await loading) as unknown as LoadResult;
			expect(data.myUpcoming).toEqual([]);
			expect(data.privateLinks).toEqual({});
			expect(data.privateEventsIncomplete).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

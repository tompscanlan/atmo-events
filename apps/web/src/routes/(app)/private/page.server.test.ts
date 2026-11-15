import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CALENDAR_COLLECTION,
	EVENT_COLLECTION,
	privateEventSpace
} from '#lib/private-events/ids.js';
import { CALENDAR_SCOPE, GUEST_SCOPE, HOST_SCOPE } from '#lib/private-events/scopes.js';

const setHeaders = vi.fn();
const beta = vi.hoisted(() => vi.fn());
vi.mock('#lib/private-events/server/beta.js', () => ({ privateEventsBeta: beta }));
const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
vi.mock('#lib/spaces/server/space-read.js', () => ({ credentialSpaceReader: () => reader }));
vi.mock('#lib/actor.js', () => ({ actorToDid: vi.fn() }));
vi.mock('#lib/private-events/server/people.js', () => ({
	verifiedHandle: async (did: string) => `${did.split(':').at(-1)}.example.com`
}));
vi.mock('#lib/private-events/private-events.remote', () => ({ createCalendar: vi.fn() }));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: () => true,
	spacesServer: () => null
}));

const { load } = await import('./+page.server');
const { default: PrivatePage } = await import('./+page.svelte');

const GUEST = 'did:plc:guestguestguestguestgues';
const HOST = 'did:plc:hosthosthosthosthosthost';
const SOUND = privateEventSpace(HOST, '3laaaaaaaaaaa');
const BROKEN = privateEventSpace(HOST, '3lbbbbbbbbbbb');
type Read = { space: string; collection: string; rkey: string };
const RECORD = {
	$type: EVENT_COLLECTION,
	name: 'Dinner',
	createdAt: '2026-11-04T00:00:00.000Z',
	startsAt: '2026-11-07T00:00:00.000Z'
};

/** What the page loads for a guest of both events, signed in, whose PDS lists both spaces. */
async function loadedPrivatePage() {
	const session = {
		did: GUEST,
		getTokenInfo: async () => ({ scope: GUEST_SCOPE }),
		handle: async () => Response.json({ spaces: [{ space: SOUND }, { space: BROKEN }] })
	};
	return load({
		locals: { session },
		cookies: { get: () => undefined, delete: () => {} },
		setHeaders
	} as never);
}

async function renderedPrivatePage() {
	const data = await loadedPrivatePage();
	return render(PrivatePage, { props: { data } as never }).body;
}

beforeEach(() => {
	reader.get.mockReset();
	beta.mockResolvedValue(false);
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('what a browser or cache keeps', () => {
	it('keeps no copy of the list', async () => {
		reader.get.mockResolvedValue(null);
		await renderedPrivatePage();
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});
});

describe('/private when a host’s server is down', () => {
	it('does not say there are none', async () => {
		reader.get.mockRejectedValue(new Error('503'));
		const body = await renderedPrivatePage();
		expect(body).not.toContain('None yet');
		expect(body).toContain('data-testid="private-events-incomplete"');
	});

	it('says there may be more calendars than it lists', async () => {
		reader.get.mockImplementation(async ({ space, collection, rkey }: Read) => {
			if (space === BROKEN) throw new Error('503');
			if (collection === CALENDAR_COLLECTION) return null;
			return {
				uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
				cid: `cid-of-${rkey}`,
				rkey,
				value: RECORD
			};
		});
		const body = await renderedPrivatePage();
		expect(body).not.toContain('Dinner');
		expect(body).toContain('data-testid="private-events-incomplete"');
	});

	it('says nothing of the kind when all is read', async () => {
		reader.get.mockImplementation(async ({ space, collection, rkey }: Read) =>
			collection === CALENDAR_COLLECTION
				? null
				: {
						uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
						cid: `cid-of-${rkey}`,
						rkey,
						value: RECORD
					}
		);
		const body = await renderedPrivatePage();
		expect(body).not.toContain('data-testid="private-events-incomplete"');
	});
});

describe('/private and private events apart from any calendar', () => {
	it('lists none of them and sends none to the browser: Your events lists them', async () => {
		reader.get.mockImplementation(async ({ space, collection, rkey }: Read) =>
			collection === CALENDAR_COLLECTION
				? null
				: {
						uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
						cid: `cid-of-${rkey}`,
						rkey,
						value: RECORD
					}
		);
		const data = await loadedPrivatePage();
		expect(JSON.stringify(data)).not.toContain('Dinner');
		const body = render(PrivatePage, { props: { data } as never }).body;
		expect(body).not.toContain('Dinner');
		expect(body).not.toMatch(/\/private\/3l[a-z]+/);
		expect(body).toContain('data-testid="calendars-footnote"');
	});
});

describe('/private with a record a host wrote badly', () => {
	it.each([
		['a mode that is not a string', { mode: 7 }],
		['a name that is not a string', { name: 7 }],
		['a start that is not a date', { startsAt: 'soon' }]
	])('still renders for their guest, without it: %s', async (_, broken) => {
		reader.get.mockImplementation(async ({ space, collection, rkey }: Read) =>
			collection === CALENDAR_COLLECTION
				? null
				: {
						uri: `${space}/${HOST}/${EVENT_COLLECTION}/${rkey}`,
						cid: `cid-of-${rkey}`,
						rkey,
						value: space === BROKEN ? { ...RECORD, name: 'Broken', ...broken } : RECORD
					}
		);

		const body = await renderedPrivatePage();

		expect(body).toMatch(/<h1[^>]*>Calendars<\/h1>/);
		expect(body).not.toContain('Broken');
		expect(body).not.toContain('data-testid="private-events-incomplete"');
	});
});

describe('/private and the beta', () => {
	it('warns that private events made in the beta will be lost', async () => {
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).toContain('will be lost');
	});
	it('points someone without the beta at Settings to make their own', async () => {
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).toMatch(/turn on private events in\s*<a href="\/settings"/);
	});
	it('does not, once they turned it on', async () => {
		beta.mockResolvedValue(true);
		reader.get.mockResolvedValue(null);
		expect(await renderedPrivatePage()).not.toContain('turn on private events in');
	});
});

describe('/private with shared calendars', () => {
	const CALENDAR = privateEventSpace(HOST, 'cal-3lcalcalcalcal');

	async function rendered(scope: string, did = GUEST, capped = false) {
		reader.get.mockImplementation(
			async ({ space, collection }: { space: string; collection: string }) => {
				if (space === CALENDAR && collection === CALENDAR_COLLECTION) {
					return {
						uri: `${space}/${HOST}/${collection}/self`,
						cid: 'c',
						rkey: 'self',
						value: { name: 'Supper club' }
					};
				}
				if (space === SOUND && collection === EVENT_COLLECTION) {
					return {
						uri: `${space}/${HOST}/${EVENT_COLLECTION}/3laaaaaaaaaaa`,
						cid: 'c',
						rkey: '3laaaaaaaaaaa',
						value: RECORD
					};
				}
				return null;
			}
		);
		reader.list.mockImplementation(async ({ space }: { space: string }) => ({
			records:
				space === CALENDAR
					? [
							{
								uri: `${space}/${HOST}/${EVENT_COLLECTION}/3lonthecal`,
								cid: 'c',
								rkey: '3lonthecal',
								value: { ...RECORD, name: 'Supper' }
							}
						]
					: [],
			capped: space === CALENDAR && capped
		}));
		const session = {
			did,
			getTokenInfo: async () => ({ scope }),
			handle: async () => Response.json({ spaces: [{ space: SOUND }, { space: CALENDAR }] })
		};
		const data = await load({
			locals: { session },
			cookies: { get: () => undefined, delete: () => {} },
			setHeaders
		} as never);
		return render(PrivatePage, { props: { data } as never }).body;
	}

	it('is called Calendars', async () => {
		const body = await rendered(GUEST_SCOPE);
		expect(body).toMatch(/<h1[^>]*>Calendars<\/h1>/);
	});

	it('lists the calendars someone is on, and no event apart from them', async () => {
		const body = await rendered(GUEST_SCOPE);
		expect(body).toContain('data-testid="shared-calendars"');
		expect(body).toContain('data-calendar="cal-3lcalcalcalcal"');
		expect(body).toContain('Supper club');
		expect(body).not.toContain('Dinner');
	});

	it('leaves a calendar’s events to the calendar’s own page, and never reads them here', async () => {
		const body = await rendered(GUEST_SCOPE);
		expect(reader.list.mock.calls.map(([q]) => q.space)).not.toContain(CALENDAR);
		expect(body).not.toContain('/calendar/cal-3lcalcalcalcal/3lonthecal');
		expect(body).not.toContain('>Supper<');
	});

	it('says nothing about how many events a calendar has, since it lists none of them', async () => {
		const body = await rendered(GUEST_SCOPE, GUEST, true);
		expect(body).not.toContain('data-testid="private-events-capped"');
		expect(body).not.toContain('data-testid="private-events-incomplete"');
	});

	it('lists the calendars someone is on with the beta off, with nothing to make one', async () => {
		const body = await rendered(GUEST_SCOPE);
		expect(body).toContain('data-testid="shared-calendars"');
		expect(body).toContain('hosthosthosthosthosthost.example.com');
		expect(body).not.toContain('data-testid="new-calendar"');
		expect(body).not.toContain('Allow atmo to make shared calendars');
	});

	it('lists the calendars with the beta on, and asks before the first one', async () => {
		beta.mockResolvedValue(true);
		const body = await rendered(`${HOST_SCOPE} ${GUEST_SCOPE}`, HOST);
		expect(body).toContain('data-testid="shared-calendars"');
		expect(body).toContain('data-calendar="cal-3lcalcalcalcal"');
		expect(body).not.toContain('data-testid="new-calendar"');
		expect(body).toContain('Allow atmo to make shared calendars');
	});

	it('offers a new shared calendar once the calendar grant is held', async () => {
		beta.mockResolvedValue(true);
		const body = await rendered(`${HOST_SCOPE} ${CALENDAR_SCOPE} ${GUEST_SCOPE}`, HOST);
		expect(body).toContain('data-testid="new-calendar"');
		expect(body).not.toContain('Allow atmo to make shared calendars');
	});
});

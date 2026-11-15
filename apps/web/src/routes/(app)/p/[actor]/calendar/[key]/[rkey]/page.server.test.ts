import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	CALENDAR_COLLECTION,
	calendarEvent,
	EVENT_COLLECTION,
	eventPath,
	privateEventSpace
} from '#lib/private-events/ids.js';
import { GUEST_SCOPE, HOST_SCOPE } from '#lib/private-events/scopes.js';

const OWNER = 'did:plc:ownerownerownerownerowner';
const PERSON = 'did:plc:personpersonpersonperson';
const KEY = 'cal-3lcalcalcalcal';
const RKEY = '3levent';
const SPACE = privateEventSpace(OWNER, KEY);
const PATH = eventPath(OWNER, calendarEvent(OWNER, KEY, RKEY));
const NAME = 'Dinner at the secret place';

const setHeaders = vi.fn();
const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
vi.mock('#lib/spaces/server/space-read.js', () => ({ credentialSpaceReader: () => reader }));
vi.mock('#lib/actor.js', () => ({ getActor: async (actor: string) => actor, actorToDid: vi.fn() }));
vi.mock('#lib/private-events/server/people.js', () => ({
	verifiedHandle: async (did: string) => `${did.split(':').at(-1)}.example.com`
}));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: () => true,
	spacesServer: () => null
}));
vi.mock('#lib/private-events/private-events.remote', () => ({
	rsvpToPrivateEvent: vi.fn(),
	cancelPrivateRsvp: vi.fn()
}));
vi.mock('#lib/atproto/auth.svelte.js', () => ({ user: { isLoggedIn: true, did: PERSON } }));
vi.mock('#lib/components/LoginModal.svelte', () => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('$app/state', () => ({ page: { url: new URL(`https://atmo.example.com${PATH}`) } }));

const route = await import('./+page.server');
const { default: EventPage } = await import('./+page.svelte');

function request(did: string | null, scope: string, rkey = RKEY, answers: unknown = {}) {
	const session = did && {
		did,
		getTokenInfo: async () => ({ scope }),
		handle: async () => Response.json(answers)
	};
	return {
		params: { actor: OWNER, key: KEY, rkey },
		locals: { session },
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		setHeaders
	} as never;
}

const load = (event: never) => route.load(event) as Promise<Record<string, unknown>>;
const page = (data: unknown) => render(EventPage, { props: { data } as never }).body;

beforeEach(() => {
	reader.get.mockReset();
	reader.writers.mockReset();
	reader.writers.mockResolvedValue([]);
	reader.get.mockImplementation(async (q: { repo: string; collection: string; rkey: string }) => {
		if (q.repo !== OWNER) return null;
		if (q.collection === CALENDAR_COLLECTION) {
			return {
				uri: `${SPACE}/${OWNER}/${q.collection}/self`,
				cid: 'c',
				rkey: 'self',
				value: { name: 'Supper club' }
			};
		}
		if (q.collection === EVENT_COLLECTION && q.rkey === RKEY) {
			return {
				uri: `${SPACE}/${OWNER}/${EVENT_COLLECTION}/${RKEY}`,
				cid: 'c',
				rkey: RKEY,
				value: {
					$type: EVENT_COLLECTION,
					name: NAME,
					createdAt: '2026-11-01T00:00:00.000Z',
					startsAt: '2099-01-01T18:00:00.000Z'
				}
			};
		}
		return null;
	});
	setHeaders.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('an event on a shared calendar', () => {
	it('shows someone on the calendar the event, and that only the people on it can see it', async () => {
		const data = await load(request(PERSON, GUEST_SCOPE));
		expect(data.view).toBe('event');
		const body = page(data);
		expect(body).toContain(NAME);
		expect(body).toContain('data-testid="private-note"');
		expect(body).toContain('Supper club');
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it('gives the owner the calendar’s people instead of a guest list to change', async () => {
		const data = await load(request(OWNER, HOST_SCOPE, RKEY, { members: [{ did: PERSON }] }));
		const body = page(data);
		expect(body).toContain('data-testid="calendar-guests"');
		expect(body).toContain(`data-guest="${PERSON}"`);
		expect(body).not.toContain('data-testid="guest-list"');
		expect(body).not.toContain('name="guest-handle"');
	});

	it('tells someone kept out what it tells anyone at a made-up key', async () => {
		reader.get.mockRejectedValue(new SpaceAccessDenied(SPACE, '400 SpaceNotFound'));
		const real = await load(request(PERSON, GUEST_SCOPE)).catch((e) => e);
		const madeUp = await load(request(PERSON, GUEST_SCOPE, '3lmadeup')).catch((e) => e);
		expect(real).toMatchObject({ status: 404 });
		expect(madeUp).toEqual(real);
	});

	it('reads the owner’s event only, never a record someone else on it wrote under its key', async () => {
		await load(request(PERSON, GUEST_SCOPE));
		const eventReads = reader.get.mock.calls
			.map(([q]) => q)
			.filter((q) => q.collection === EVENT_COLLECTION);
		expect(eventReads.map((q) => q.repo)).toEqual([OWNER]);
	});
});

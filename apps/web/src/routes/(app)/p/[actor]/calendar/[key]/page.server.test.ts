import { render } from 'svelte/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	CALENDAR_COLLECTION,
	calendarPath,
	EVENT_COLLECTION,
	privateEventSpace
} from '#lib/private-events/ids.js';
import { GUEST_SCOPE, HOST_SCOPE } from '#lib/private-events/scopes.js';

const OWNER = 'did:plc:ownerownerownerownerowner';
const PERSON = 'did:plc:personpersonpersonperson';
const KEY = 'cal-3lcalcalcalcal';
const SPACE = privateEventSpace(OWNER, KEY);
const NAME = 'Supper club';
const EVENT_NAME = 'Dinner at the secret place';

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
vi.mock('#lib/private-events/private-events.remote.js', () => ({
	addPersonToCalendar: vi.fn(),
	removePersonFromCalendar: vi.fn(),
	renameCalendar: vi.fn(),
	deleteCalendar: vi.fn()
}));
vi.mock('#lib/private-events/private-events.remote', () => ({
	addPersonToCalendar: vi.fn(),
	removePersonFromCalendar: vi.fn(),
	renameCalendar: vi.fn(),
	deleteCalendar: vi.fn()
}));
vi.mock('#lib/components/LoginModal.svelte', () => ({ atProtoLoginModalState: { show: vi.fn() } }));
vi.mock('$app/state', () => ({
	page: { url: new URL(`https://atmo.example.com${calendarPath(OWNER, KEY)}`) }
}));

const route = await import('./+page.server');
const { default: CalendarPage } = await import('./+page.svelte');

function request(did: string | null, scope: string, key = KEY, answers: unknown = {}) {
	const session = did && {
		did,
		getTokenInfo: async () => ({ scope }),
		handle: async () => Response.json(answers)
	};
	return {
		params: { actor: OWNER, key },
		locals: { session },
		cookies: { get: () => undefined, set: () => {}, delete: () => {} },
		setHeaders
	} as never;
}

const load = (event: never) => route.load(event) as Promise<Record<string, unknown>>;
const page = (data: unknown) => render(CalendarPage, { props: { data } as never }).body;

function theCalendarHolds() {
	reader.get.mockImplementation(async (q: { collection: string }) =>
		q.collection === CALENDAR_COLLECTION
			? {
					uri: `${SPACE}/${OWNER}/${q.collection}/self`,
					cid: 'c',
					rkey: 'self',
					value: { name: NAME }
				}
			: null
	);
	reader.list.mockResolvedValue({
		records: [
			{
				uri: `${SPACE}/${OWNER}/${EVENT_COLLECTION}/3levent`,
				cid: 'c',
				rkey: '3levent',
				value: {
					$type: EVENT_COLLECTION,
					name: EVENT_NAME,
					createdAt: '2026-11-01T00:00:00.000Z',
					startsAt: '2099-01-01T18:00:00.000Z'
				}
			}
		],
		capped: false
	});
}

/** What happens when the reader is turned away, as for someone not on the calendar. */
function keptOut() {
	const denied = new SpaceAccessDenied(SPACE, '400 SpaceNotFound');
	reader.get.mockRejectedValue(denied);
	reader.list.mockRejectedValue(denied);
}

beforeEach(() => {
	reader.get.mockReset();
	reader.list.mockReset();
	setHeaders.mockClear();
	theCalendarHolds();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('a shared calendar’s page', () => {
	it('shows someone on it its name and events, and says who can see them', async () => {
		const data = await load(request(PERSON, GUEST_SCOPE));
		expect(data.view).toBe('calendar');
		const body = page(data);
		expect(body).toContain(NAME);
		expect(body).toContain(EVENT_NAME);
		expect(body).toContain('data-testid="calendar-private-note"');
		expect(body).not.toContain('data-testid="calendar-people"');
		expect(body).not.toContain('data-testid="calendar-owner-actions"');
	});

	it('shows the owner the people on it, and what only the owner can do', async () => {
		const data = await load(request(OWNER, HOST_SCOPE, KEY, { members: [{ did: PERSON }] }));
		const body = page(data);
		expect(body).toContain('data-testid="calendar-people"');
		expect(body).toContain(`data-person="${PERSON}"`);
		expect(body).toContain('data-testid="calendar-owner-actions"');
		expect(body).toContain(`/create?audience=calendar&amp;calendar=${KEY}`);
	});

	it('keeps no copy, and asks not to be indexed', async () => {
		const data = await load(request(PERSON, GUEST_SCOPE));
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
		expect(data.robots).toBe('noindex');
	});

	it('asks someone signed out to sign in, and reads nothing', async () => {
		const data = await load(request(null, ''));
		expect(data.view).toBe('signed-out');
		expect(reader.get).not.toHaveBeenCalled();
	});

	it('asks for the guest grant first, and reads nothing', async () => {
		const data = await load(request(PERSON, 'atproto'));
		expect(data.view).toBe('grant');
		expect(reader.get).not.toHaveBeenCalled();
	});

	it('tells someone kept out what it tells anyone at a made-up key, in the same words', async () => {
		keptOut();
		const real = await load(request(PERSON, GUEST_SCOPE)).catch((e) => e);
		const madeUp = await load(request(PERSON, GUEST_SCOPE, 'cal-3lmadeupmadeup')).catch((e) => e);
		const notACalendar = await load(request(PERSON, GUEST_SCOPE, '3lsingleevent')).catch((e) => e);
		expect(real).toMatchObject({ status: 404 });
		expect(madeUp).toEqual(real);
		expect(notACalendar).toEqual(real);
	});

	it('does not pass an outage off as not there, and logs not whose or which', async () => {
		reader.list.mockRejectedValue(new Error(`503 at ${SPACE}`));
		await expect(load(request(PERSON, GUEST_SCOPE))).rejects.toMatchObject({ status: 503 });
		const logs = String(vi.mocked(console.error).mock.calls);
		for (const secret of [PERSON, OWNER, KEY]) expect(logs).not.toContain(secret);
	});

	it('has no action a form could post to', () => {
		expect((route as { actions?: unknown }).actions).toBeUndefined();
	});
});

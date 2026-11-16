import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import {
	CALENDAR_COLLECTION,
	EVENT_COLLECTION,
	privateEventSpace
} from '#lib/private-events/ids.js';
import { GUEST_SCOPE, HOST_SCOPE } from '#lib/private-events/scopes.js';

// Who may see a private event's page and its edit page, at both of its addresses: a single event's
// own, and an event's on a shared calendar. Each case runs at both.
const HOST = 'did:plc:hosthosthosthosthosthost';
const GUEST = 'did:plc:guestguestguestguestgues';
const KEY = '3lcalcalcalcal';
const RKEY = '3levent';

const setHeaders = vi.fn();
const reader = { get: vi.fn(), list: vi.fn(), writers: vi.fn() };
vi.mock('#lib/spaces/server/space-read.js', () => ({ credentialSpaceReader: () => reader }));
vi.mock('#lib/actor.js', () => ({
	getActor: async (actor: string) => (actor === 'no-one.example.com' ? null : actor),
	actorToDid: vi.fn()
}));
vi.mock('#lib/private-events/server/people.js', () => ({ verifiedHandle: async () => null }));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: () => true,
	spacesServer: () => null
}));

type Load = (event: never) => Promise<Record<string, unknown>>;
const addresses: [string, { view: Load; edit: Load; params: object; spaceKey: string }][] = [
	[
		'a single event',
		{
			view: (await import('./private/[rkey]/+page.server')).load as never,
			edit: (await import('./private/[rkey]/edit/+page.server')).load as never,
			params: { rkey: RKEY },
			spaceKey: RKEY
		}
	],
	[
		'an event on a calendar',
		{
			view: (await import('./calendar/[key]/[rkey]/+page.server')).load as never,
			edit: (await import('./calendar/[key]/[rkey]/edit/+page.server')).load as never,
			params: { key: KEY, rkey: RKEY },
			spaceKey: KEY
		}
	]
];

function request(did: string | null, scope: string, params: object, actor = HOST) {
	const session = did && {
		did,
		getTokenInfo: async () => ({ scope }),
		handle: async () => Response.json({ members: [] })
	};
	const cookies = { get: () => undefined, set: () => {}, delete: () => {} };
	return { params: { actor, ...params }, locals: { session }, cookies, setHeaders } as never;
}

/** The host's space under `spaceKey` holds the event, and its name unless `named` is false. */
function theSpaceHolds(spaceKey: string, named = true) {
	const space = privateEventSpace(HOST, spaceKey);
	const held: Record<string, object | null> = {
		[EVENT_COLLECTION]: {
			$type: EVENT_COLLECTION,
			name: 'Dinner',
			createdAt: '2026-11-01T00:00:00.000Z',
			startsAt: '2099-01-01T18:00:00.000Z'
		},
		[CALENDAR_COLLECTION]: named ? { name: 'Supper club' } : null
	};
	reader.get.mockImplementation(async (q: { space: string; repo: string; collection: string }) => {
		const value = q.space === space && q.repo === HOST ? held[q.collection] : null;
		return value && { uri: `${space}/${HOST}/${q.collection}/x`, cid: 'cid', rkey: RKEY, value };
	});
}

/** Anyone's space under any key holds an event. */
function ownEventToo() {
	const event = reader.get.getMockImplementation()!;
	reader.get.mockImplementation(async (q: { space: string; repo: string; collection: string }) =>
		event({ ...q, space: q.space.replace(GUEST, HOST), repo: HOST })
	);
}
const keptOut = () =>
	reader.get.mockRejectedValue(new SpaceAccessDenied('at://x', '403 NotMember'));
const gone = () =>
	reader.get.mockRejectedValue(new SpaceAccessDenied('at://x', '400 SpaceNotFound'));
const empty = () => reader.get.mockResolvedValue(null);
const unreachable = () =>
	reader.get.mockRejectedValue(new Error(`fetch failed: ${privateEventSpace(HOST, KEY)}/${RKEY}`));
const logged = () => String(vi.mocked(console.error).mock.calls);

/** What the address answers for an event that isn't there: everyone kept out must get the same. */
async function madeUp(load: Load, params: object) {
	empty();
	return load(request(GUEST, GUEST_SCOPE, { ...params, rkey: '3lmadeup' })).catch((e) => e);
}

beforeEach(() => {
	reader.get.mockReset();
	reader.list.mockReset();
	reader.list.mockResolvedValue({ records: [], capped: false });
	reader.writers.mockReset();
	reader.writers.mockResolvedValue([]);
	setHeaders.mockClear();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe.each(addresses)('the page of %s', (_, { view, params, spaceKey }) => {
	it.each([
		['someone signed out', null, '', 'signed-out'],
		['someone without the guest grant', GUEST, 'atproto', 'grant'],
		['its host without the host grant', HOST, GUEST_SCOPE, 'grant']
	])('asks %s for a step first, and reads nothing', async (_, did, scope, step) => {
		theSpaceHolds(spaceKey);
		const data = await view(request(did, scope, params));
		expect(data).toMatchObject({ view: step, robots: 'noindex' });
		expect(reader.get).not.toHaveBeenCalled();
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it.each([
		['someone on its list', GUEST, GUEST_SCOPE],
		['its host', HOST, HOST_SCOPE]
	])('shows %s the event, and keeps no copy', async (_, did, scope) => {
		theSpaceHolds(spaceKey);
		const data = await view(request(did, scope, params));
		expect(data).toMatchObject({ view: 'event', pageTitle: 'Dinner', robots: 'noindex' });
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it.each([
		['someone not on its list', keptOut, HOST],
		['anyone, once its space is gone', gone, HOST],
		['anyone, for a host no one can find', () => theSpaceHolds(spaceKey), 'no-one.example.com']
	])('tells %s what it tells anyone at a made-up key', async (_, setup, actor) => {
		const answer = await madeUp(view, params);
		expect(answer).toMatchObject({ status: 404 });
		setup();
		setHeaders.mockClear();
		await expect(view(request(GUEST, GUEST_SCOPE, params, actor))).rejects.toEqual(answer);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it('does not pass an outage off as not there, and logs not whose or which', async () => {
		unreachable();
		await expect(view(request(GUEST, GUEST_SCOPE, params))).rejects.toMatchObject({ status: 503 });
		for (const secret of [GUEST, HOST, KEY, RKEY]) expect(logged()).not.toContain(secret);
	});

	it('has no action a form could post to', async () => {
		const route = await import(
			spaceKey === RKEY ? './private/[rkey]/+page.server' : './calendar/[key]/[rkey]/+page.server'
		);
		expect((route as { actions?: unknown }).actions).toBeUndefined();
	});
});

describe.each(addresses)('the edit page of %s', (_, { edit, params, spaceKey }) => {
	it('gives its host their own event, from its own space, and keeps no copy', async () => {
		theSpaceHolds(spaceKey);
		const data = await edit(request(HOST, HOST_SCOPE, params));
		expect(data).toMatchObject({ eventData: { name: 'Dinner' }, actorDid: HOST, rkey: RKEY });
		expect(data.calendarKey).toBe(spaceKey === KEY ? KEY : undefined);
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it.each([
		['someone signed out', null, '', () => {}],
		// Its edit page reads the caller's own space, so this one has an event under the same key.
		['someone else, with an event of their own', GUEST, HOST_SCOPE, ownEventToo],
		['its host without the host grant', HOST, GUEST_SCOPE, () => {}],
		['its host, once its space is gone', HOST, HOST_SCOPE, gone],
		['its host, at a key that holds no event', HOST, HOST_SCOPE, empty]
	])('tells %s it isn’t there, and keeps no copy', async (_, did, scope, setup) => {
		theSpaceHolds(spaceKey);
		setup();
		await expect(edit(request(did, scope, params))).rejects.toMatchObject({
			status: 404,
			body: { message: "This event isn't available." }
		});
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it('does not pass an outage off as not there, and logs not whose or which', async () => {
		unreachable();
		await expect(edit(request(HOST, HOST_SCOPE, params))).rejects.toMatchObject({ status: 503 });
		for (const secret of [HOST, KEY, RKEY]) expect(logged()).not.toContain(secret);
	});
});

describe('an event in a space with no name', () => {
	it('shows at its own address, and nowhere as on a calendar', async () => {
		const [[, single], [, onCalendar]] = addresses;
		theSpaceHolds(RKEY, false);
		await expect(single.view(request(GUEST, GUEST_SCOPE, single.params))).resolves.toMatchObject({
			view: 'event',
			calendar: null
		});
		await expect(single.edit(request(HOST, HOST_SCOPE, single.params))).resolves.toBeDefined();

		const calendarAddress = { key: RKEY, rkey: RKEY };
		const answer = await madeUp(onCalendar.view, onCalendar.params);
		theSpaceHolds(RKEY, false);
		await expect(onCalendar.view(request(GUEST, GUEST_SCOPE, calendarAddress))).rejects.toEqual(
			answer
		);
		await expect(onCalendar.edit(request(HOST, HOST_SCOPE, calendarAddress))).rejects.toMatchObject(
			{ status: 404 }
		);
	});
});

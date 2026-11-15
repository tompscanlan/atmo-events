import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'did:plc:ownerownerownerownerowner';
const PERSON = 'did:plc:personpersonpersonperson';
const KEY = 'cal-3lcalcalcalcal';
const RKEY = '3levent';

const setHeaders = vi.fn();
const callerSession = vi.fn();
const readPrivateEventForEdit = vi.fn();
const isOwnCalendar = vi.fn();
vi.mock('#lib/actor.js', () => ({ getActor: async (actor: string) => actor }));
vi.mock('#lib/private-events/scopes.js', () => ({ holdsHostGrant: () => true }));
vi.mock('#lib/private-events/server/caller.js', () => ({
	callerSession: (session: unknown) => callerSession(session)
}));
vi.mock('#lib/private-events/server/enabled.js', () => ({ privateEventsEnabled: () => true }));
vi.mock('#lib/private-events/server/events.js', () => ({
	readPrivateEventForEdit: (...args: unknown[]) => readPrivateEventForEdit(...args),
	isOwnCalendar: (...args: unknown[]) => isOwnCalendar(...args)
}));
vi.mock('#lib/spaces/server/other-servers.js', () => ({ timeLimitedNetwork: () => ({}) }));

const { load } = await import('./+page.server');

const request = (key = KEY) =>
	({
		params: { actor: OWNER, key, rkey: RKEY },
		locals: { session: {} },
		setHeaders
	}) as unknown as Parameters<typeof load>[0];

describe('editing an event on a shared calendar', () => {
	beforeEach(() => {
		setHeaders.mockClear();
		callerSession.mockReset();
		readPrivateEventForEdit.mockReset();
		readPrivateEventForEdit.mockResolvedValue({ name: 'Dinner' });
		isOwnCalendar.mockReset();
		isOwnCalendar.mockResolvedValue(true);
	});

	it('reads the owner’s own event from the calendar, and keeps no copy', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		await expect(load(request())).resolves.toMatchObject({ rkey: RKEY, calendarKey: KEY });
		expect(readPrivateEventForEdit).toHaveBeenCalledWith(expect.anything(), {
			spaceKey: KEY,
			rkey: RKEY
		});
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it('is not there for someone on the calendar', async () => {
		callerSession.mockResolvedValue({ did: PERSON, scope: '' });
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
		expect(readPrivateEventForEdit).not.toHaveBeenCalled();
	});

	it('reads an event on a calendar that was a single event’s space the same way', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		await expect(load(request('3lsingle'))).resolves.toMatchObject({ calendarKey: '3lsingle' });
		expect(readPrivateEventForEdit).toHaveBeenCalledWith(expect.anything(), {
			spaceKey: '3lsingle',
			rkey: RKEY
		});
	});

	it('is not there for a single event’s space with no name, as at a made-up address', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		isOwnCalendar.mockResolvedValue(false);
		const unnamed = await load(request('3lsingle')).catch((e) => e);
		readPrivateEventForEdit.mockResolvedValue(null);
		const madeUp = await load(request('3lmadeup')).catch((e) => e);
		expect(unnamed).toMatchObject({ status: 404 });
		expect(unnamed).toEqual(madeUp);
	});

	it('is not there where the space isn’t, rather than failing', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		const { SpaceAccessDenied } = await import('#lib/spaces/server/space-credential.js');
		isOwnCalendar.mockRejectedValue(new SpaceAccessDenied('at://x', '400 SpaceNotFound'));
		readPrivateEventForEdit.mockResolvedValue(null);
		await expect(load(request('3lgone'))).rejects.toMatchObject({ status: 404 });
	});

	it('is not there where the space holds no such event', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		readPrivateEventForEdit.mockResolvedValue(null);
		await expect(load(request('3lsingle'))).rejects.toMatchObject({ status: 404 });
	});
});

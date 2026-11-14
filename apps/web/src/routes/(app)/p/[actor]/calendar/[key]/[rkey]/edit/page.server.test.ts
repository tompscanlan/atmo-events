import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'did:plc:ownerownerownerownerowner';
const MEMBER = 'did:plc:membermembermembermember';
const KEY = 'cal-3lcalcalcalcal';
const RKEY = '3levent';

const setHeaders = vi.fn();
const callerSession = vi.fn();
const readPrivateEventForEdit = vi.fn();
vi.mock('#lib/actor.js', () => ({ getActor: async (actor: string) => actor }));
vi.mock('#lib/private-events/scopes.js', () => ({ holdsHostGrant: () => true }));
vi.mock('#lib/private-events/server/caller.js', () => ({
	callerSession: (session: unknown) => callerSession(session)
}));
vi.mock('#lib/private-events/server/enabled.js', () => ({ privateEventsEnabled: () => true }));
vi.mock('#lib/private-events/server/events.js', () => ({
	readPrivateEventForEdit: (...args: unknown[]) => readPrivateEventForEdit(...args)
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

	it('is not there for a member', async () => {
		callerSession.mockResolvedValue({ did: MEMBER, scope: '' });
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
		expect(readPrivateEventForEdit).not.toHaveBeenCalled();
	});

	it('is not there at a key that is not a calendar’s', async () => {
		callerSession.mockResolvedValue({ did: OWNER, scope: '' });
		await expect(load(request('3lsingle'))).rejects.toMatchObject({ status: 404 });
		expect(readPrivateEventForEdit).not.toHaveBeenCalled();
	});
});

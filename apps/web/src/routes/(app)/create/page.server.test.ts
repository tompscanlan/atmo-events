import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	enabled: vi.fn(),
	beta: vi.fn(),
	caller: vi.fn(),
	calendars: vi.fn()
}));
vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: mocks.enabled,
	spacesServer: () => null
}));
vi.mock('#lib/private-events/server/beta.js', () => ({ privateEventsBeta: mocks.beta }));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.caller }));
vi.mock('#lib/private-events/server/calendars.js', () => ({ ownCalendars: mocks.calendars }));
const { HOST_SCOPE } = await import('#lib/private-events/scopes.js');
const { load } = await import('./+page.server');

const locals = { did: 'did:plc:alice', session: null, client: {} };
const cookies = { get: () => undefined, delete: () => {} };
const run = () =>
	load({ locals, cookies } as never) as Promise<{
		privateEvents: boolean;
		calendars: { key: string; name: string | null }[];
	}>;

beforeEach(() => {
	mocks.enabled.mockReturnValue(true);
	mocks.beta.mockResolvedValue(true);
	mocks.caller.mockResolvedValue(null);
	mocks.calendars.mockReset();
	mocks.calendars.mockResolvedValue([]);
});

describe('the private choice on /create', () => {
	it('is offered to someone who turned the beta on', async () => {
		expect((await run()).privateEvents).toBe(true);
		expect(mocks.beta).toHaveBeenCalledWith(locals);
	});
	it('is not offered with the beta off', async () => {
		mocks.beta.mockResolvedValue(false);
		expect((await run()).privateEvents).toBe(false);
	});
	it('is not offered, and the beta not read, where the deployment has private events off', async () => {
		mocks.enabled.mockReturnValue(false);
		expect((await run()).privateEvents).toBe(false);
		expect(mocks.beta).not.toHaveBeenCalled();
	});
});

describe('putting the event on a shared calendar from /create', () => {
	const host = { did: 'did:plc:alice', scope: HOST_SCOPE, handle: async () => Response.json({}) };
	const supper = { key: 'cal-3lcalcalcalcal', name: 'Supper club', host: host.did };

	it('offers the host’s own calendars', async () => {
		mocks.caller.mockResolvedValue(host);
		mocks.calendars.mockResolvedValue([supper]);
		expect((await run()).calendars).toEqual([{ key: supper.key, name: 'Supper club' }]);
	});

	it('offers none, and reads none, to someone who can’t host', async () => {
		mocks.caller.mockResolvedValue({ ...host, scope: 'atproto' });
		expect((await run()).calendars).toEqual([]);
		expect(mocks.calendars).not.toHaveBeenCalled();
	});

	it('offers none with the beta off', async () => {
		mocks.beta.mockResolvedValue(false);
		mocks.caller.mockResolvedValue(host);
		mocks.calendars.mockResolvedValue([supper]);
		expect((await run()).calendars).toEqual([]);
	});

	it('still opens when the calendars can’t be read', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.caller.mockResolvedValue(host);
		mocks.calendars.mockRejectedValue(new Error('503'));
		const data = await run();
		expect(data.privateEvents).toBe(true);
		expect(data.calendars).toEqual([]);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('#lib/private-events/server/enabled.js', () => ({
	privateEventsEnabled: vi.fn(() => true)
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: vi.fn(async () => null) }));

import { load } from './+layout.server';
import { GUEST_SCOPE, HOST_SCOPES } from '#lib/private-events/scopes.js';
import { callerSession } from '#lib/private-events/server/caller.js';
import { privateEventsEnabled } from '#lib/private-events/server/enabled.js';

const ME = 'did:plc:mememememememememememememe';
const request = (locals: Partial<App.Locals>) =>
	({ locals }) as unknown as Parameters<typeof load>[0];
const signedIn = () => request({ did: ME, session: {} as never });

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(privateEventsEnabled).mockReturnValue(true);
});

describe('whether the Calendars tab shows without the beta', () => {
	it('says yes to someone whose session allows opening private events', async () => {
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: GUEST_SCOPE } as never);
		expect(await load(signedIn())).toEqual({
			privateEventsEnabled: true,
			privateEventsGranted: true
		});
	});

	it('says yes to a host', async () => {
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: HOST_SCOPES.join(' ') } as never);
		expect(await load(signedIn())).toMatchObject({ privateEventsGranted: true });
	});

	it('says no to a session that allows nothing private', async () => {
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: 'atproto' } as never);
		expect(await load(signedIn())).toMatchObject({ privateEventsGranted: false });
	});

	it('says no when the session cannot be read', async () => {
		vi.mocked(callerSession).mockResolvedValue(null);
		expect(await load(signedIn())).toMatchObject({ privateEventsGranted: false });
	});

	it('reads no session for someone signed out', async () => {
		expect(await load(request({ did: null }))).toEqual({
			privateEventsEnabled: true,
			privateEventsGranted: false
		});
		expect(callerSession).not.toHaveBeenCalled();
	});

	it('reads no session where the deployment has private events off', async () => {
		vi.mocked(privateEventsEnabled).mockReturnValue(false);
		vi.mocked(callerSession).mockResolvedValue({ did: ME, scope: GUEST_SCOPE } as never);
		expect(await load(signedIn())).toEqual({
			privateEventsEnabled: false,
			privateEventsGranted: false
		});
		expect(callerSession).not.toHaveBeenCalled();
	});
});

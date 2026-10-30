import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	atGroupHost: vi.fn(),
	available: vi.fn(),
	startGroupLink: vi.fn(),
	finishGroupLink: vi.fn()
}));
vi.mock('#lib/groups/server/group.js', () => ({
	resolveGroup: mocks.resolveGroup,
	atGroupHost: mocks.atGroupHost
}));
vi.mock('#lib/groups/server/sign-in.js', () => ({
	groupSignInAvailable: mocks.available,
	startGroupLink: mocks.startGroupLink,
	finishGroupLink: mocks.finishGroupLink
}));

import { POST } from './link/+server';
import { GET } from './callback/+server';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';

function linkRequest(group: string, did: string | null) {
	const body = new FormData();
	body.set('group', group);
	return {
		request: new Request('https://atmo.example/oauth/group/link', { method: 'POST', body }),
		locals: { did }
	} as unknown as Parameters<typeof POST>[0];
}

const callback = (did: string | null) =>
	({
		url: new URL('https://atmo.example/oauth/group/callback?state=s&code=c'),
		locals: { did }
	}) as unknown as Parameters<typeof GET>[0];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.available.mockReturnValue(true);
	mocks.resolveGroup.mockResolvedValue({ did: GROUP, handle: 'knit.example', pds: 'https://h' });
	mocks.atGroupHost.mockReturnValue(true);
});

describe('starting a link', () => {
	it('sends a signed-out browser to sign in first', async () => {
		await expect(POST(linkRequest(GROUP, null))).rejects.toMatchObject({
			status: 303,
			location: '/login'
		});
		expect(mocks.startGroupLink).not.toHaveBeenCalled();
	});

	it('refuses a group at another host', async () => {
		mocks.atGroupHost.mockReturnValue(false);
		await expect(POST(linkRequest('@knit.example', ALICE))).rejects.toMatchObject({
			location: '/groups?link=not-here'
		});
		expect(mocks.resolveGroup).toHaveBeenCalledWith('knit.example');
	});

	it("sends the browser to the group's host for the signed-in person", async () => {
		mocks.startGroupLink.mockResolvedValue(new URL('https://h/oauth/authorize?x=1'));
		await expect(POST(linkRequest(GROUP, ALICE))).rejects.toMatchObject({
			status: 303,
			location: 'https://h/oauth/authorize?x=1'
		});
		expect(mocks.startGroupLink).toHaveBeenCalledWith(GROUP, ALICE);
	});
});

describe('the callback', () => {
	it('opens the group once it is linked', async () => {
		mocks.finishGroupLink.mockResolvedValue({ ok: true, groupDid: GROUP });
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: `/groups/${GROUP}?link=linked`
		});
		expect(mocks.finishGroupLink.mock.calls[0][1]).toBe(ALICE);
	});

	it("goes back to the list on a refusal, since the group's page may be a 404", async () => {
		mocks.finishGroupLink.mockResolvedValue({ ok: false, groupDid: GROUP, reason: 'x' });
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: '/groups?link=failed'
		});
	});
});

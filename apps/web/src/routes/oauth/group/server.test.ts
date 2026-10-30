import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	resolveGroup: vi.fn(),
	atGroupHost: vi.fn(),
	available: vi.fn(),
	startGroupLink: vi.fn(),
	startGroupCreate: vi.fn(),
	finishGroupSignIn: vi.fn(),
	requireGroupWriter: vi.fn(),
	finishSetup: vi.fn()
}));
vi.mock('#lib/groups/server/group.js', async (original) => ({
	...(await original()),
	resolveGroup: mocks.resolveGroup,
	atGroupHost: mocks.atGroupHost
}));
vi.mock('#lib/groups/server/sign-in.js', () => ({
	groupSignInAvailable: mocks.available,
	startGroupLink: mocks.startGroupLink,
	startGroupCreate: mocks.startGroupCreate,
	finishGroupSignIn: mocks.finishGroupSignIn
}));
vi.mock('#lib/groups/server/context.js', async (original) => ({
	...(await original()),
	requireGroupWriter: mocks.requireGroupWriter
}));
vi.mock('#lib/groups/server/create.js', () => ({ finishSetup: mocks.finishSetup }));

import { POST } from './link/+server';
import { POST as CREATE } from './create/+server';
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

function createRequest(fields: Record<string, string>, did: string | null) {
	const body = new FormData();
	for (const [name, value] of Object.entries(fields)) body.set(name, value);
	return {
		request: new Request('https://atmo.example/oauth/group/create', { method: 'POST', body }),
		locals: { did }
	} as unknown as Parameters<typeof CREATE>[0];
}

const FORM = {
	name: ' Knitters ',
	description: '',
	joinPolicy: 'approval',
	visibility: 'public',
	listed: 'on'
};

const SETTINGS = {
	name: 'Knitters',
	description: null,
	joinPolicy: 'approval',
	public: true,
	listed: true
};

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
		mocks.finishGroupSignIn.mockResolvedValue({ ok: true, groupDid: GROUP, created: null });
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: `/groups/${GROUP}?link=linked`
		});
		expect(mocks.finishGroupSignIn.mock.calls[0][1]).toBe(ALICE);
	});

	it("goes back to the list on a refusal, since the group's page may be a 404", async () => {
		mocks.finishGroupSignIn.mockResolvedValue({ ok: false, groupDid: GROUP, reason: 'x' });
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: '/groups?link=failed'
		});
	});

	it('writes a new group its settings as the group, for the person who made it', async () => {
		const writer = { did: GROUP, handle: vi.fn() };
		mocks.finishGroupSignIn.mockResolvedValue({ ok: true, groupDid: GROUP, created: SETTINGS });
		mocks.requireGroupWriter.mockResolvedValue(writer);
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: `/groups/${GROUP}?created=done`
		});
		expect(mocks.requireGroupWriter).toHaveBeenCalledWith(GROUP, ALICE);
		expect(mocks.finishSetup).toHaveBeenCalledWith(
			writer,
			expect.objectContaining({ did: GROUP }),
			{
				settings: SETTINGS,
				by: ALICE
			}
		);
	});

	it('opens a new group whose setup stopped, for its creator to finish there', async () => {
		mocks.finishGroupSignIn.mockResolvedValue({ ok: true, groupDid: GROUP, created: SETTINGS });
		mocks.requireGroupWriter.mockResolvedValue({ did: GROUP, handle: vi.fn() });
		mocks.finishSetup.mockRejectedValue(new Error('the PDS stopped'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(GET(callback(ALICE))).rejects.toMatchObject({
			location: `/groups/${GROUP}?created=stopped`
		});
	});
});

describe('starting a create', () => {
	it('is not here without a group host to make it at', async () => {
		mocks.available.mockReturnValue(false);
		await expect(CREATE(createRequest(FORM, ALICE))).rejects.toMatchObject({ status: 404 });
	});

	it('sends a signed-out browser to sign in first', async () => {
		await expect(CREATE(createRequest(FORM, null))).rejects.toMatchObject({
			location: '/login'
		});
		expect(mocks.startGroupCreate).not.toHaveBeenCalled();
	});

	it('sends a form whose settings do not hold back to it, starting nothing', async () => {
		await expect(CREATE(createRequest({ ...FORM, name: ' ' }, ALICE))).rejects.toMatchObject({
			location: '/groups/create?invalid=1'
		});
		expect(mocks.startGroupCreate).not.toHaveBeenCalled();
	});

	it("sends the creator to the host's sign-up with the form's settings", async () => {
		mocks.startGroupCreate.mockResolvedValue(new URL('https://h/oauth/authorize?x=1'));
		await expect(CREATE(createRequest(FORM, ALICE))).rejects.toMatchObject({
			status: 303,
			location: 'https://h/oauth/authorize?x=1'
		});
		expect(mocks.startGroupCreate).toHaveBeenCalledWith(ALICE, SETTINGS);

		await CREATE(createRequest({ ...FORM, visibility: 'private' }, ALICE)).catch(() => {});
		expect(mocks.startGroupCreate).toHaveBeenLastCalledWith(ALICE, {
			...SETTINGS,
			public: false,
			listed: false
		});
	});

	it('says so when the host cannot be reached', async () => {
		mocks.startGroupCreate.mockRejectedValue(new Error('fetch failed'));
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(CREATE(createRequest(FORM, ALICE))).rejects.toMatchObject({
			location: '/groups/create?failed=1'
		});
	});
});

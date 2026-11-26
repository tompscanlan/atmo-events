import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	browseGroups: vi.fn(),
	yourGroups: vi.fn(),
	available: vi.fn(),
	unfinishedGroups: vi.fn(),
	callerSession: vi.fn()
}));
const setHeaders = vi.fn();
vi.mock('#lib/groups/server/browse.js', () => ({
	browseGroups: mocks.browseGroups,
	yourGroups: mocks.yourGroups
}));
vi.mock('#lib/private-events/server/caller.js', () => ({ callerSession: mocks.callerSession }));
vi.mock('#lib/groups/server/sign-in.js', () => ({ groupSignInAvailable: mocks.available }));
vi.mock('#lib/groups/server/create.js', () => ({ unfinishedGroups: mocks.unfinishedGroups }));

import { load } from './+page.server';

const ALICE = 'did:plc:alice';
const request = (query = '', did: string | null = null) =>
	({
		locals: { did, session: did ? {} : null },
		url: new URL(`https://atmo.example/groups${query}`),
		setHeaders
	}) as unknown as Parameters<typeof load>[0];

beforeEach(() => {
	vi.resetAllMocks();
	setHeaders.mockClear();
	Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
	mocks.browseGroups.mockResolvedValue({
		groups: [],
		cursor: null,
		declaredUnavailable: false,
		crowded: [{ server: 'https://pds.example:8443', more: 4 }]
	});
});

describe('the groups list', () => {
	it('names each crowded server by its host', async () => {
		const page = await load(request());
		expect(mocks.browseGroups).toHaveBeenCalledWith(null, { cursor: null, server: null });
		expect(page).toMatchObject({
			server: null,
			crowded: [{ server: 'https://pds.example:8443', host: 'pds.example:8443', more: 4 }]
		});
	});

	it('is never stored, since linked groups lead it', async () => {
		await load(request());
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
	});

	it("shows one server's groups for an origin, and is a 404 for anything else", async () => {
		const page = await load(request('?server=https%3A%2F%2Fpds.example&cursor=c'));
		expect(mocks.browseGroups).toHaveBeenCalledWith(null, {
			cursor: 'c',
			server: 'https://pds.example'
		});
		expect(page).toMatchObject({
			pageTitle: 'Groups at pds.example',
			server: { origin: 'https://pds.example', host: 'pds.example' }
		});

		for (const server of ['', 'pds.example', 'https://pds.example/', 'ftp://pds.example']) {
			await expect(load(request(`?${new URLSearchParams({ server })}`))).rejects.toMatchObject({
				status: 404
			});
		}
	});

	it('shows only its own notices, so a made-up ?link= is no notice at all', async () => {
		expect((await load(request('?link=failed'))).notice).toEqual(expect.any(String));
		for (const link of ['toString', 'constructor', '__proto__', 'nope']) {
			expect((await load(request(`?link=${link}`))).notice).toBeNull();
		}
	});

	it('is a 404 with groups off', async () => {
		Reflect.deleteProperty(env, 'GROUP_HOST_URL');
		await expect(load(request())).rejects.toMatchObject({ status: 404 });
	});
});

describe('making a group from the list', () => {
	const signedIn = () =>
		({
			locals: { did: 'did:plc:alice' },
			url: new URL('https://atmo.example/groups'),
			setHeaders
		}) as unknown as Parameters<typeof load>[0];

	it('counts the groups the caller made and has not linked yet', async () => {
		mocks.available.mockReturnValue(true);
		mocks.unfinishedGroups.mockResolvedValue([{ did: 'did:plc:g', handle: 'g.example' }]);
		expect(await load(signedIn())).toMatchObject({ canLink: true, unfinished: 1 });
		expect(mocks.unfinishedGroups).toHaveBeenCalledWith('did:plc:alice');
	});

	it('looks for none signed out, or without a group sign-in', async () => {
		mocks.available.mockReturnValue(false);
		expect(await load(signedIn())).toMatchObject({ canLink: false, unfinished: 0 });
		expect(await load(request())).toMatchObject({ canLink: false, unfinished: 0 });
		expect(mocks.unfinishedGroups).not.toHaveBeenCalled();
	});

	it("leads with the person's own groups, on the whole list's first page only", async () => {
		const person = { did: ALICE, scope: 'atproto', handle: vi.fn() };
		mocks.callerSession.mockResolvedValue(person);
		mocks.unfinishedGroups.mockResolvedValue([]);
		mocks.yourGroups.mockResolvedValue([
			{ did: 'did:plc:group', name: 'Knitters', handle: 'knit.example' }
		]);
		expect(await load(request('', ALICE))).toMatchObject({
			yourGroups: [{ did: 'did:plc:group', name: 'Knitters' }],
			access: 'ask'
		});
		expect(mocks.yourGroups).toHaveBeenCalledWith(person);

		mocks.yourGroups.mockClear();
		expect(await load(request('?cursor=c', ALICE))).toMatchObject({ yourGroups: null });
		expect(await load(request('?server=https%3A%2F%2Fpds.example', ALICE))).toMatchObject({
			yourGroups: null
		});
		expect(mocks.yourGroups).not.toHaveBeenCalled();
	});

	it('asks a signed-out visitor nothing', async () => {
		expect(await load(request())).toMatchObject({ yourGroups: null, access: null });
		expect(mocks.callerSession).not.toHaveBeenCalled();
	});
});

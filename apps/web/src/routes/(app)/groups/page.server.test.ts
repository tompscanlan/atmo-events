import { beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';

const mocks = vi.hoisted(() => ({
	browseUpcoming: vi.fn(),
	browseDeclared: vi.fn(),
	browseLinked: vi.fn(),
	yourGroups: vi.fn(),
	available: vi.fn(),
	unfinishedGroups: vi.fn(),
	callerSession: vi.fn()
}));
const setHeaders = vi.fn();
vi.mock('#lib/groups/server/browse.js', () => ({
	browseUpcoming: mocks.browseUpcoming,
	browseDeclared: mocks.browseDeclared,
	browseLinked: mocks.browseLinked,
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
	mocks.browseUpcoming.mockResolvedValue({
		groups: [{ did: 'did:plc:soon' }],
		cursor: 'up2',
		servers: [{ server: 'https://pds.example', host: 'pds.example', groups: 4, upcoming: 1 }],
		unavailable: false
	});
	mocks.browseLinked.mockResolvedValue([]);
	mocks.browseDeclared.mockResolvedValue({
		groups: [{ did: 'did:plc:found' }],
		cursor: 'found2',
		unavailable: false
	});
});

describe('the groups list', () => {
	it('leads with the groups with an event coming, and the servers', async () => {
		const page = await load(request());
		expect(mocks.browseUpcoming).toHaveBeenCalledWith(null);
		expect(mocks.browseDeclared).not.toHaveBeenCalled();
		expect(page).toMatchObject({
			server: null,
			q: null,
			upcoming: [{ did: 'did:plc:soon' }],
			servers: [{ server: 'https://pds.example', groups: 4, upcoming: 1 }],
			groups: [],
			cursor: 'up2'
		});
	});

	it('is never stored, since the person’s own groups lead it', async () => {
		await load(request());
		expect(setHeaders).toHaveBeenCalledWith({ 'cache-control': 'no-store' });
		await load(request('?server=https%3A%2F%2Fpds.example&q=knit'));
		expect(setHeaders).toHaveBeenLastCalledWith({ 'cache-control': 'no-store' });
	});

	it("shows one server's groups for an origin, and is a 404 for anything else", async () => {
		const page = await load(request('?server=https%3A%2F%2Fpds.example&cursor=c'));
		expect(mocks.browseDeclared).toHaveBeenCalledWith({
			cursor: 'c',
			server: 'https://pds.example',
			q: null
		});
		expect(mocks.browseUpcoming).not.toHaveBeenCalled();
		expect(page).toMatchObject({
			pageTitle: 'Groups at pds.example',
			server: { origin: 'https://pds.example', host: 'pds.example' },
			upcoming: [],
			servers: [],
			groups: [{ did: 'did:plc:found' }],
			cursor: 'found2'
		});

		for (const server of ['', 'pds.example', 'https://pds.example/', 'ftp://pds.example']) {
			await expect(load(request(`?${new URLSearchParams({ server })}`))).rejects.toMatchObject({
				status: 404
			});
		}
	});

	it('searches all servers, or one, for what was typed, and reads a blank search as none', async () => {
		const page = await load(request(`?${new URLSearchParams({ q: '  @Knit ' })}`));
		expect(mocks.browseDeclared).toHaveBeenLastCalledWith({
			cursor: null,
			server: null,
			q: 'Knit'
		});
		expect(page).toMatchObject({ q: 'Knit', server: null, groups: [{ did: 'did:plc:found' }] });

		await load(request(`?${new URLSearchParams({ q: 'knit', server: 'https://pds.example' })}`));
		expect(mocks.browseDeclared).toHaveBeenLastCalledWith({
			cursor: null,
			server: 'https://pds.example',
			q: 'knit'
		});

		mocks.browseDeclared.mockClear();
		expect(await load(request('?q=%20%20'))).toMatchObject({
			q: null,
			upcoming: [{ did: 'did:plc:soon' }]
		});
		expect(mocks.browseDeclared).not.toHaveBeenCalled();
	});

	it('shows only its own notices, so a made-up ?link= is no notice at all', async () => {
		expect((await load(request('?link=failed'))).notice).toEqual(expect.any(String));
		for (const link of ['toString', 'constructor', '__proto__', 'nope']) {
			expect((await load(request(`?link=${link}`))).notice).toBeNull();
		}
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
		expect(await load(request('?q=knit', ALICE))).toMatchObject({ yourGroups: null });
		expect(mocks.yourGroups).not.toHaveBeenCalled();
	});

	it('shows a linker their linked groups without the membership permission, and no one else', async () => {
		const BOB = 'did:plc:bob';
		const linked = {
			did: 'did:plc:private',
			name: 'p.example',
			handle: 'p.example',
			description: null
		};
		mocks.browseLinked.mockImplementation(async (did: string) => (did === ALICE ? [linked] : []));
		// A sign-in without the permission that lists a person's groups at the host.
		mocks.callerSession.mockImplementation(async () => ({ scope: 'atproto', handle: vi.fn() }));
		mocks.yourGroups.mockResolvedValue(null);
		mocks.unfinishedGroups.mockResolvedValue([]);
		expect(await load(request('', ALICE))).toMatchObject({ yourGroups: null, linked: [linked] });
		expect((await load(request('', BOB))).linked).toEqual([]);
		expect((await load(request())).linked).toEqual([]);
		expect(mocks.browseLinked.mock.calls.map(([did]) => did)).toEqual([ALICE, BOB]);
		// Only on the whole list's first page.
		expect((await load(request('?q=knit', ALICE))).linked).toEqual([]);
	});

	it('shows a linked group once, in "Your groups", when that lists it', async () => {
		mocks.callerSession.mockResolvedValue({ did: ALICE, scope: 'atproto', handle: vi.fn() });
		mocks.unfinishedGroups.mockResolvedValue([]);
		mocks.yourGroups.mockResolvedValue([{ did: 'did:plc:a', name: 'A', handle: 'a.example' }]);
		mocks.browseLinked.mockResolvedValue([
			{ did: 'did:plc:a', name: 'A', handle: 'a.example', description: null },
			{ did: 'did:plc:b', name: 'B', handle: 'b.example', description: null }
		]);
		const page = await load(request('', ALICE));
		expect(page.linked.map((group) => group.did)).toEqual(['did:plc:b']);
	});

	it('asks a signed-out visitor nothing', async () => {
		expect(await load(request())).toMatchObject({ yourGroups: null, access: null });
		expect(mocks.callerSession).not.toHaveBeenCalled();
	});
});

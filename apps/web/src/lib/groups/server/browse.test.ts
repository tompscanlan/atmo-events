import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listUpcomingGroups: vi.fn(),
	listGroupServers: vi.fn(),
	listDeclaredGroups: vi.fn(),
	readGroupLabels: vi.fn(),
	actorGroups: vi.fn()
}));
vi.mock('./group', () => ({
	listUpcomingGroups: mocks.listUpcomingGroups,
	listGroupServers: mocks.listGroupServers,
	listDeclaredGroups: mocks.listDeclaredGroups,
	readGroupLabels: mocks.readGroupLabels
}));
vi.mock('./host', () => ({ actorGroups: mocks.actorGroups }));

import { browseDeclared, browseUpcoming, yourGroups } from './browse';

const next = (title: string) => ({
	uri: `at://x/e/${title}`,
	title,
	startsAt: '2030-01-01T00:00:00.000Z'
});

beforeEach(() => {
	vi.resetAllMocks();
	vi.spyOn(console, 'error').mockImplementation(() => {});
	mocks.listUpcomingGroups.mockResolvedValue({ groups: [], cursor: null });
	mocks.listGroupServers.mockResolvedValue([]);
	mocks.readGroupLabels.mockResolvedValue(new Map());
});

describe('browseUpcoming', () => {
	it('names each group by its cached name, else its handle, else its DID', async () => {
		mocks.listUpcomingGroups.mockResolvedValue({
			groups: [
				{
					did: 'did:plc:a',
					server: 'https://a.example',
					handle: 'a.example',
					name: 'Knitters',
					next: next('Purl')
				},
				{
					did: 'did:plc:b',
					server: 'https://a.example',
					handle: 'b.example',
					name: null,
					next: next('Ride')
				},
				{ did: 'did:plc:c', server: '', handle: null, name: null, next: next('Walk') }
			],
			cursor: 'c2'
		});
		const page = await browseUpcoming();
		expect(page.groups.map((g) => [g.did, g.name, g.next.title])).toEqual([
			['did:plc:a', 'Knitters', 'Purl'],
			['did:plc:b', 'b.example', 'Ride'],
			['did:plc:c', 'did:plc:c', 'Walk']
		]);
		expect(page).toMatchObject({ cursor: 'c2', unavailable: false });
	});

	it("names the servers by host on the first page only, leaving out one it couldn't link to", async () => {
		mocks.listGroupServers.mockResolvedValue([
			{ server: 'https://pds.example:8443', groups: 4, upcoming: 1 },
			{ server: 'https://pds.example:443', groups: 2, upcoming: 0 }
		]);
		expect((await browseUpcoming()).servers).toEqual([
			{ server: 'https://pds.example:8443', host: 'pds.example:8443', groups: 4, upcoming: 1 }
		]);
		expect((await browseUpcoming('c2')).servers).toEqual([]);
		expect(mocks.listGroupServers).toHaveBeenCalledOnce();
		expect(mocks.listUpcomingGroups).toHaveBeenLastCalledWith('c2');
	});

	it('says when the index did not answer, and still lists when the servers cannot be read', async () => {
		mocks.listUpcomingGroups.mockRejectedValueOnce(new Error('down'));
		expect(await browseUpcoming()).toMatchObject({ groups: [], cursor: null, unavailable: true });
		mocks.listGroupServers.mockRejectedValueOnce(new Error('down'));
		expect(await browseUpcoming()).toMatchObject({ servers: [], unavailable: false });
	});
});

describe('browseDeclared', () => {
	it("lists the index's page, named from the database, or by handle or DID", async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			dids: ['did:plc:a', 'did:plc:b', 'did:plc:c'],
			cursor: 'c2'
		});
		mocks.readGroupLabels.mockResolvedValue(
			new Map([
				['did:plc:a', { handle: 'a.example', name: 'Knitters', description: 'Yarn' }],
				['did:plc:b', { handle: 'b.example', name: null, description: null }]
			])
		);
		const page = await browseDeclared({ server: 'https://pds.example', q: 'knit', cursor: 'c1' });
		expect(mocks.listDeclaredGroups).toHaveBeenCalledWith({
			server: 'https://pds.example',
			q: 'knit',
			cursor: 'c1'
		});
		expect(page).toEqual({
			groups: [
				{ did: 'did:plc:a', name: 'Knitters', handle: 'a.example', description: 'Yarn' },
				{ did: 'did:plc:b', name: 'b.example', handle: 'b.example', description: null },
				{ did: 'did:plc:c', name: 'did:plc:c', handle: null, description: null }
			],
			cursor: 'c2',
			unavailable: false
		});
	});

	it('says when the index did not answer, and lists by DID when the names cannot be read', async () => {
		mocks.listDeclaredGroups.mockRejectedValueOnce(new Error('down'));
		expect(await browseDeclared({ q: 'knit' })).toEqual({
			groups: [],
			cursor: null,
			unavailable: true
		});
		mocks.listDeclaredGroups.mockResolvedValue({ dids: ['did:plc:a'], cursor: null });
		mocks.readGroupLabels.mockRejectedValue(new Error('down'));
		expect((await browseDeclared({ q: 'knit' })).groups.map((g) => g.name)).toEqual(['did:plc:a']);
	});
});

describe('yourGroups', () => {
	const ALICE = 'did:plc:alice';
	const YOURS = 'rpc:org.atgrp.internal.getActorGroups?aud=*';
	const person = (scope = `atproto ${YOURS}`) => ({ did: ALICE, scope, handle: vi.fn() });

	it('names each group as the host shows it to a member, or by its handle', async () => {
		mocks.actorGroups.mockResolvedValue([
			{ did: 'did:plc:a', handle: 'a.groups.example', displayName: 'Knitters' },
			{ did: 'did:plc:b', handle: 'b.groups.example', displayName: null }
		]);
		expect(await yourGroups(person())).toEqual([
			{ did: 'did:plc:a', name: 'Knitters', handle: 'a.groups.example' },
			{ did: 'did:plc:b', name: 'b.groups.example', handle: 'b.groups.example' }
		]);
	});

	it('asks nothing of a sign-in that cannot ask the host, and says nothing when it fails', async () => {
		expect(await yourGroups(person('atproto'))).toBeNull();
		expect(mocks.actorGroups).not.toHaveBeenCalled();

		vi.spyOn(console, 'error').mockImplementation(() => {});
		mocks.actorGroups.mockRejectedValue(new Error('host down'));
		expect(await yourGroups(person())).toBeNull();
	});
});

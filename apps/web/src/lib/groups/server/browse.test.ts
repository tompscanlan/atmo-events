import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listUpcomingGroups: vi.fn(),
	listGroupServers: vi.fn(),
	listDeclaredGroups: vi.fn(),
	readGroupLabels: vi.fn(),
	resolveGroup: vi.fn(),
	linkedGroups: vi.fn(),
	heldOf: vi.fn()
}));
vi.mock('./group', () => ({
	listUpcomingGroups: mocks.listUpcomingGroups,
	listGroupServers: mocks.listGroupServers,
	listDeclaredGroups: mocks.listDeclaredGroups,
	readGroupLabels: mocks.readGroupLabels,
	resolveGroup: mocks.resolveGroup,
	heldOf: mocks.heldOf
}));
vi.mock('./sign-in', () => ({ linkedGroups: mocks.linkedGroups }));

import { browseDeclared, browseLinked, browseUpcoming } from './browse';

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
	mocks.heldOf.mockImplementation(async (_server: string, dids: string[]) => dids);
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

	it("lists of a server's page only the accounts it holds, as far as that can be asked", async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			dids: ['did:plc:a', 'did:plc:claims'],
			cursor: null
		});
		mocks.heldOf.mockResolvedValue(['did:plc:a']);
		const page = await browseDeclared({ server: 'https://groups.example' });
		expect(mocks.heldOf).toHaveBeenCalledWith('https://groups.example', [
			'did:plc:a',
			'did:plc:claims'
		]);
		expect(page.groups.map((group) => group.did)).toEqual(['did:plc:a']);
		// A search across every server is not a server's list.
		mocks.heldOf.mockClear();
		await browseDeclared({ q: 'knit' });
		expect(mocks.heldOf).not.toHaveBeenCalled();
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

describe('browseLinked', () => {
	it("lists the person's own links, named from the database, looking up only a group it knows nothing of", async () => {
		mocks.linkedGroups.mockImplementation(async (did: string) =>
			did === 'did:plc:alice' ? ['did:plc:public', 'did:plc:named', 'did:plc:unlisted'] : []
		);
		mocks.readGroupLabels.mockResolvedValue(
			new Map([
				['did:plc:public', { handle: 'p.example', name: 'Knitters', description: null }],
				['did:plc:named', { handle: null, name: 'Riders', description: null }]
			])
		);
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:unlisted', handle: 'u.example' });
		expect(await browseLinked('did:plc:alice')).toEqual([
			{ did: 'did:plc:public', name: 'Knitters', handle: 'p.example', description: null },
			{ did: 'did:plc:named', name: 'Riders', handle: null, description: null },
			{ did: 'did:plc:unlisted', name: 'u.example', handle: 'u.example', description: null }
		]);
		expect(mocks.resolveGroup).toHaveBeenCalledExactlyOnceWith('did:plc:unlisted');
		expect(await browseLinked('did:plc:bob')).toEqual([]);
	});
});

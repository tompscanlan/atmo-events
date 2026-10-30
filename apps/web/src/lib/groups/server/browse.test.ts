import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listDeclaredGroups: vi.fn(),
	listCrowdedServers: vi.fn(),
	readCachedProfiles: vi.fn(),
	readCachedHandles: vi.fn(),
	resolveGroup: vi.fn(),
	linkedGroups: vi.fn()
}));
vi.mock('./group', () => ({
	listDeclaredGroups: mocks.listDeclaredGroups,
	listCrowdedServers: mocks.listCrowdedServers,
	readCachedProfiles: mocks.readCachedProfiles,
	readCachedHandles: mocks.readCachedHandles,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./sign-in', () => ({ linkedGroups: mocks.linkedGroups }));

import { browseGroups } from './browse';

const profile = (name: string) => ({ name, description: null, handle: `${name}.example` });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.linkedGroups.mockResolvedValue([]);
	mocks.readCachedProfiles.mockResolvedValue(new Map());
	mocks.readCachedHandles.mockResolvedValue(new Map());
	mocks.listCrowdedServers.mockResolvedValue([]);
});

describe('browseGroups', () => {
	it("puts the caller's linked groups first, once each", async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [
				{ did: 'did:plc:b', indexedAt: 2 },
				{ did: 'did:plc:a', indexedAt: 1 }
			],
			cursor: null
		});
		mocks.linkedGroups.mockResolvedValue(['did:plc:a', 'did:plc:private']);
		mocks.readCachedProfiles.mockResolvedValue(
			new Map([
				['did:plc:a', profile('a')],
				['did:plc:b', profile('b')]
			])
		);
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:private', handle: 'p.example' });

		const { groups } = await browseGroups('did:plc:alice');
		expect(groups.map((g) => [g.did, g.name, g.linked])).toEqual([
			['did:plc:a', 'a', true],
			['did:plc:private', 'p.example', true],
			['did:plc:b', 'b', false]
		]);
		expect(mocks.resolveGroup).toHaveBeenCalledExactlyOnceWith('did:plc:private');
	});

	it('shows a declared group with no cached profile by the handle the index holds, and looks nothing up', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [
				{ did: 'did:plc:b', indexedAt: 2 },
				{ did: 'did:plc:a', indexedAt: 1 }
			],
			cursor: null
		});
		mocks.readCachedProfiles.mockResolvedValue(new Map([['did:plc:a', profile('a')]]));
		mocks.readCachedHandles.mockResolvedValue(new Map([['did:plc:b', 'knit.example']]));
		const { groups } = await browseGroups(null);
		expect(groups).toEqual([
			{
				did: 'did:plc:b',
				name: 'knit.example',
				handle: 'knit.example',
				description: null,
				linked: false
			},
			{ did: 'did:plc:a', name: 'a', handle: 'a.example', description: null, linked: false }
		]);
		expect(mocks.readCachedHandles).toHaveBeenCalledWith(['did:plc:b', 'did:plc:a']);
		expect(mocks.resolveGroup).not.toHaveBeenCalled();
		expect(mocks.linkedGroups).not.toHaveBeenCalled();
	});

	it('shows a declared group by its DID when neither a cached profile nor the index has a handle', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [{ did: 'did:plc:b', indexedAt: 2 }],
			cursor: null
		});
		const { groups } = await browseGroups(null);
		expect(groups).toEqual([
			{ did: 'did:plc:b', name: 'did:plc:b', handle: null, description: null, linked: false }
		]);
		expect(mocks.resolveGroup).not.toHaveBeenCalled();
	});

	it('looks up a linked group only when the index has no handle for it', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({ groups: [], cursor: null });
		mocks.linkedGroups.mockResolvedValue(['did:plc:known', 'did:plc:unknown']);
		mocks.readCachedHandles.mockResolvedValue(new Map([['did:plc:known', 'known.example']]));
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:unknown', handle: 'unknown.example' });
		const { groups } = await browseGroups('did:plc:alice');
		expect(groups.map((g) => [g.did, g.name])).toEqual([
			['did:plc:known', 'known.example'],
			['did:plc:unknown', 'unknown.example']
		]);
		expect(mocks.resolveGroup).toHaveBeenCalledExactlyOnceWith('did:plc:unknown');
	});

	it('still lists, by cached profile or DID, when the handles cannot be read', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [
				{ did: 'did:plc:b', indexedAt: 2 },
				{ did: 'did:plc:a', indexedAt: 1 }
			],
			cursor: null
		});
		mocks.readCachedProfiles.mockResolvedValue(new Map([['did:plc:a', profile('a')]]));
		mocks.readCachedHandles.mockRejectedValue(new Error('down'));
		const { groups } = await browseGroups(null);
		expect(groups.map((g) => [g.did, g.name])).toEqual([
			['did:plc:b', 'did:plc:b'],
			['did:plc:a', 'a']
		]);
	});

	it('pages the declared groups, with the linked ones on the first page only', async () => {
		mocks.linkedGroups.mockResolvedValue(['did:plc:a']);
		mocks.listDeclaredGroups.mockResolvedValueOnce({
			groups: [{ did: 'did:plc:b', indexedAt: 2 }],
			cursor: 'page2'
		});
		const first = await browseGroups('did:plc:alice');
		expect(first.groups.map((g) => g.did)).toEqual(['did:plc:a', 'did:plc:b']);
		expect(first.cursor).toBe('page2');

		mocks.listDeclaredGroups.mockResolvedValueOnce({
			groups: [
				{ did: 'did:plc:a', indexedAt: 1 },
				{ did: 'did:plc:c', indexedAt: 1 }
			],
			cursor: null
		});
		const second = await browseGroups('did:plc:alice', { cursor: 'page2' });
		expect(mocks.listDeclaredGroups).toHaveBeenLastCalledWith({ cursor: 'page2', server: null });
		expect(second.groups.map((g) => [g.did, g.linked])).toEqual([['did:plc:c', false]]);
		expect(second.cursor).toBeNull();
		// The servers the list leaves groups out of are named once, on its first page.
		expect(mocks.listCrowdedServers).toHaveBeenCalledOnce();
	});

	it('names the crowded servers on the first page, and still lists when that read fails', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({ groups: [], cursor: null });
		mocks.listCrowdedServers.mockResolvedValueOnce([{ server: 'https://pds.example', more: 3 }]);
		expect((await browseGroups(null)).crowded).toEqual([
			{ server: 'https://pds.example', more: 3 }
		]);
		mocks.listCrowdedServers.mockRejectedValueOnce(new Error('down'));
		expect(await browseGroups(null)).toMatchObject({ crowded: [], declaredUnavailable: false });
	});

	it("lists all of one server's groups, linked ones in place, on that server's page", async () => {
		mocks.linkedGroups.mockResolvedValue(['did:plc:a', 'did:plc:elsewhere']);
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [
				{ did: 'did:plc:b', indexedAt: 2 },
				{ did: 'did:plc:a', indexedAt: 1 }
			],
			cursor: null
		});
		const page = await browseGroups('did:plc:alice', { server: 'https://pds.example' });
		expect(mocks.listDeclaredGroups).toHaveBeenCalledWith({
			cursor: null,
			server: 'https://pds.example'
		});
		expect(page.groups.map((g) => [g.did, g.linked])).toEqual([
			['did:plc:b', false],
			['did:plc:a', true]
		]);
		expect(page.crowded).toEqual([]);
		expect(mocks.listCrowdedServers).not.toHaveBeenCalled();
	});

	it('still lists linked groups when the index is down', async () => {
		mocks.listDeclaredGroups.mockRejectedValue(new Error('down'));
		mocks.linkedGroups.mockResolvedValue(['did:plc:a']);
		mocks.readCachedProfiles.mockResolvedValue(new Map([['did:plc:a', profile('a')]]));
		expect(await browseGroups('did:plc:alice')).toMatchObject({
			groups: [{ did: 'did:plc:a' }],
			declaredUnavailable: true
		});
	});
});

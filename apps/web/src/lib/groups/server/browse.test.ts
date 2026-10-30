import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listDeclaredGroups: vi.fn(),
	listCrowdedServers: vi.fn(),
	readCards: vi.fn(),
	resolveGroup: vi.fn(),
	linkedGroups: vi.fn()
}));
vi.mock('./group', () => ({
	listDeclaredGroups: mocks.listDeclaredGroups,
	listCrowdedServers: mocks.listCrowdedServers,
	readCards: mocks.readCards,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./sign-in', () => ({ linkedGroups: mocks.linkedGroups }));

import { browseGroups } from './browse';

const card = (name: string) => ({ name, description: null, handle: `${name}.example` });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.linkedGroups.mockResolvedValue([]);
	mocks.readCards.mockResolvedValue(new Map());
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
		mocks.readCards.mockResolvedValue(
			new Map([
				['did:plc:a', card('a')],
				['did:plc:b', card('b')]
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

	it('shows a declared group without a card by its DID, and looks nothing up', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [{ did: 'did:plc:b', indexedAt: 2 }],
			cursor: null
		});
		const { groups } = await browseGroups(null);
		expect(groups).toEqual([
			{ did: 'did:plc:b', name: 'did:plc:b', handle: null, description: null, linked: false }
		]);
		expect(mocks.resolveGroup).not.toHaveBeenCalled();
		expect(mocks.linkedGroups).not.toHaveBeenCalled();
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
		mocks.readCards.mockResolvedValue(new Map([['did:plc:a', card('a')]]));
		expect(await browseGroups('did:plc:alice')).toMatchObject({
			groups: [{ did: 'did:plc:a' }],
			declaredUnavailable: true
		});
	});
});

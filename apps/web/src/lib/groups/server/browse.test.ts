import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	listDeclaredGroups: vi.fn(),
	readCards: vi.fn(),
	resolveGroup: vi.fn(),
	linkedGroups: vi.fn(),
	groupsOfPerson: vi.fn()
}));
vi.mock('./group', () => ({
	listDeclaredGroups: mocks.listDeclaredGroups,
	readCards: mocks.readCards,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./sign-in', () => ({ linkedGroups: mocks.linkedGroups }));
vi.mock('./person', () => ({ groupsOfPerson: mocks.groupsOfPerson }));

import { browseGroups } from './browse';

const card = (name: string) => ({ name, description: null, handle: `${name}.example` });

beforeEach(() => {
	vi.resetAllMocks();
	mocks.linkedGroups.mockResolvedValue([]);
	mocks.readCards.mockResolvedValue(new Map());
});

describe('browseGroups', () => {
	it("puts the caller's linked groups first, once each", async () => {
		mocks.listDeclaredGroups.mockResolvedValue([
			{ did: 'did:plc:b', indexedAt: 2 },
			{ did: 'did:plc:a', indexedAt: 1 }
		]);
		mocks.linkedGroups.mockResolvedValue(['did:plc:a', 'did:plc:private']);
		mocks.readCards.mockResolvedValue(
			new Map([
				['did:plc:a', card('a')],
				['did:plc:b', card('b')]
			])
		);
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:private', handle: 'p.example' });

		const { groups } = await browseGroups({ did: 'did:plc:alice', session: null });
		expect(groups.map((g) => [g.did, g.name, g.linked])).toEqual([
			['did:plc:a', 'a', true],
			['did:plc:private', 'p.example', true],
			['did:plc:b', 'b', false]
		]);
		expect(mocks.resolveGroup).toHaveBeenCalledExactlyOnceWith('did:plc:private');
	});

	it('shows a declared group without a card by its DID, and looks nothing up', async () => {
		mocks.listDeclaredGroups.mockResolvedValue([{ did: 'did:plc:b', indexedAt: 2 }]);
		const { groups } = await browseGroups({ did: null, session: null });
		expect(groups).toEqual([
			{
				did: 'did:plc:b',
				name: 'did:plc:b',
				handle: null,
				description: null,
				linked: false,
				member: false
			}
		]);
		expect(mocks.resolveGroup).not.toHaveBeenCalled();
		expect(mocks.linkedGroups).not.toHaveBeenCalled();
	});

	it('still lists linked groups when the index is down', async () => {
		mocks.listDeclaredGroups.mockRejectedValue(new Error('down'));
		mocks.linkedGroups.mockResolvedValue(['did:plc:a']);
		mocks.readCards.mockResolvedValue(new Map([['did:plc:a', card('a')]]));
		expect(await browseGroups({ did: 'did:plc:alice', session: null })).toMatchObject({
			groups: [{ did: 'did:plc:a' }],
			declaredUnavailable: true
		});
	});
});

describe('your groups', () => {
	const GRANTED =
		'atproto space:group.opensocial.meta?authority=*&action=read space:group.opensocial.members?authority=*&action=read_self';
	const viewer = (scope: string) => ({
		did: 'did:plc:alice',
		session: { did: 'did:plc:alice', getTokenInfo: async () => ({ scope }), handle: vi.fn() }
	});

	it('lists the groups the person belongs to first, by their own read', async () => {
		mocks.listDeclaredGroups.mockResolvedValue([{ did: 'did:plc:public', indexedAt: 2 }]);
		mocks.groupsOfPerson.mockResolvedValue([
			{
				did: 'did:plc:private',
				meta: { profile: { name: 'Quiet', description: null }, public: false }
			}
		]);
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:private', handle: 'quiet.example' });

		const { groups } = await browseGroups(viewer(GRANTED) as never);
		expect(groups.map((g) => [g.did, g.name, g.member])).toEqual([
			['did:plc:private', 'Quiet', true],
			['did:plc:public', 'did:plc:public', false]
		]);
		expect(mocks.readCards).toHaveBeenCalledWith(['did:plc:public']);
	});

	it('asks nothing of a sign-in without the group scopes', async () => {
		mocks.listDeclaredGroups.mockResolvedValue([]);
		await browseGroups(viewer('atproto') as never);
		expect(mocks.groupsOfPerson).not.toHaveBeenCalled();
	});
});

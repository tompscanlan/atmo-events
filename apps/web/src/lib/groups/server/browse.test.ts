import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CALENDAR_RSVP_SCOPE } from '../scopes';

const mocks = vi.hoisted(() => ({
	listDeclaredGroups: vi.fn(),
	listCrowdedServers: vi.fn(),
	readCachedProfiles: vi.fn(),
	readCachedHandles: vi.fn(),
	resolveGroup: vi.fn(),
	linkedGroups: vi.fn(),
	groupsOfPerson: vi.fn()
}));
vi.mock('./group', () => ({
	listDeclaredGroups: mocks.listDeclaredGroups,
	listCrowdedServers: mocks.listCrowdedServers,
	readCachedProfiles: mocks.readCachedProfiles,
	readCachedHandles: mocks.readCachedHandles,
	resolveGroup: mocks.resolveGroup
}));
vi.mock('./sign-in', () => ({ linkedGroups: mocks.linkedGroups }));
vi.mock('./person', () => ({ groupsOfPerson: mocks.groupsOfPerson }));

import { browseGroups } from './browse';

const profile = (name: string) => ({ name, description: null, handle: `${name}.example` });
const ALICE = { did: 'did:plc:alice' as const, session: null };
const VISITOR = { did: null, session: null };

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

		const { groups } = await browseGroups(ALICE);
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
		const { groups } = await browseGroups(VISITOR);
		expect(groups).toEqual([
			{
				did: 'did:plc:b',
				name: 'knit.example',
				handle: 'knit.example',
				description: null,
				linked: false,
				member: false
			},
			{
				did: 'did:plc:a',
				name: 'a',
				handle: 'a.example',
				description: null,
				linked: false,
				member: false
			}
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
		const { groups } = await browseGroups(VISITOR);
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
	});

	it('looks up a linked group only when the index has no handle for it', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({ groups: [], cursor: null });
		mocks.linkedGroups.mockResolvedValue(['did:plc:known', 'did:plc:unknown']);
		mocks.readCachedHandles.mockResolvedValue(new Map([['did:plc:known', 'known.example']]));
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:unknown', handle: 'unknown.example' });
		const { groups } = await browseGroups(ALICE);
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
		const { groups } = await browseGroups(VISITOR);
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
		const first = await browseGroups(ALICE);
		expect(first.groups.map((g) => g.did)).toEqual(['did:plc:a', 'did:plc:b']);
		expect(first.cursor).toBe('page2');

		mocks.listDeclaredGroups.mockResolvedValueOnce({
			groups: [
				{ did: 'did:plc:a', indexedAt: 1 },
				{ did: 'did:plc:c', indexedAt: 1 }
			],
			cursor: null
		});
		const second = await browseGroups(ALICE, { cursor: 'page2' });
		expect(mocks.listDeclaredGroups).toHaveBeenLastCalledWith({ cursor: 'page2', server: null });
		expect(second.groups.map((g) => [g.did, g.linked])).toEqual([['did:plc:c', false]]);
		expect(second.cursor).toBeNull();
		// The servers the list leaves groups out of are named once, on its first page.
		expect(mocks.listCrowdedServers).toHaveBeenCalledOnce();
	});

	it('names the crowded servers on the first page, and still lists when that read fails', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({ groups: [], cursor: null });
		mocks.listCrowdedServers.mockResolvedValueOnce([{ server: 'https://pds.example', more: 3 }]);
		expect((await browseGroups(VISITOR)).crowded).toEqual([
			{ server: 'https://pds.example', more: 3 }
		]);
		mocks.listCrowdedServers.mockRejectedValueOnce(new Error('down'));
		expect(await browseGroups(VISITOR)).toMatchObject({ crowded: [], declaredUnavailable: false });
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
		const page = await browseGroups(ALICE, { server: 'https://pds.example' });
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
		expect(await browseGroups(ALICE)).toMatchObject({
			groups: [{ did: 'did:plc:a' }],
			declaredUnavailable: true
		});
	});
});

describe('your groups', () => {
	const GRANTED = `atproto space:group.opensocial.meta?authority=*&action=read space:group.opensocial.members?authority=*&action=read_self ${CALENDAR_RSVP_SCOPE}`;
	const viewer = (scope: string) => ({
		did: 'did:plc:alice',
		session: { did: 'did:plc:alice', getTokenInfo: async () => ({ scope }), handle: vi.fn() }
	});
	const QUIET = {
		did: 'did:plc:private',
		meta: { profile: { name: 'Quiet', description: null }, public: false }
	};

	it('lists the groups the person belongs to first, by their own read', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [{ did: 'did:plc:public', indexedAt: 2 }],
			cursor: null
		});
		mocks.groupsOfPerson.mockResolvedValue([QUIET]);
		mocks.resolveGroup.mockResolvedValue({ did: 'did:plc:private', handle: 'quiet.example' });

		const { groups } = await browseGroups(viewer(GRANTED) as never);
		expect(groups.map((g) => [g.did, g.name, g.member])).toEqual([
			['did:plc:private', 'Quiet', true],
			['did:plc:public', 'did:plc:public', false]
		]);
		expect(mocks.readCachedProfiles).toHaveBeenCalledWith(['did:plc:public']);
	});

	it("keeps the person's groups off the later pages, which their first page already led with", async () => {
		mocks.groupsOfPerson.mockResolvedValue([QUIET]);
		mocks.listDeclaredGroups.mockResolvedValue({
			groups: [
				{ did: 'did:plc:private', indexedAt: 1 },
				{ did: 'did:plc:c', indexedAt: 1 }
			],
			cursor: null
		});
		const second = await browseGroups(viewer(GRANTED) as never, { cursor: 'page2' });
		expect(second.groups.map((g) => g.did)).toEqual(['did:plc:c']);
	});

	it('asks nothing of a sign-in without the group scopes, and says to ask for them', async () => {
		mocks.listDeclaredGroups.mockResolvedValue({ groups: [], cursor: null });
		const page = await browseGroups(viewer('atproto') as never);
		expect(mocks.groupsOfPerson).not.toHaveBeenCalled();
		expect(page.askAccess).toBe(true);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from './space-credential';
import type { CallerSession } from './caller';

const mocks = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('./space-read', () => ({ credentialSpaceReader: () => ({ get: mocks.get }) }));

import { groupSpacesOf, groupsOfPerson, isMemberAsPerson, readMetaAsPerson } from './person';

const ALICE = 'did:plc:alice';

function caller(pages: Array<{ spaces: unknown[]; cursor?: string }>): CallerSession {
	let call = 0;
	return {
		did: ALICE,
		scope: '',
		handle: vi.fn(async () => Response.json(pages[call++] ?? { spaces: [] }))
	};
}

const space = (did: string) => ({ uri: `at://${did}/space/group.opensocial.members/self` });

beforeEach(() => vi.resetAllMocks());

describe('groupSpacesOf', () => {
	it('reads every page of members spaces and keeps each group once', async () => {
		const c = caller([
			{ spaces: [space('did:plc:a'), space('did:plc:b')], cursor: 'p2' },
			{ spaces: [space('did:plc:a'), { uri: 'nonsense' }] }
		]);
		expect(await groupSpacesOf(c)).toEqual(['did:plc:a', 'did:plc:b']);
		const [first, second] = vi.mocked(c.handle).mock.calls.map(([pathname]) => pathname);
		expect(first).toContain('spaceType=group.opensocial.members');
		expect(second).toContain('cursor=p2');
	});

	it('stops on a repeated cursor', async () => {
		const c = caller([
			{ spaces: [space('did:plc:a')], cursor: 'same' },
			{ spaces: [space('did:plc:b')], cursor: 'same' }
		]);
		expect(await groupSpacesOf(c)).toEqual(['did:plc:a', 'did:plc:b']);
		expect(c.handle).toHaveBeenCalledTimes(2);
	});
});

describe('readMetaAsPerson', () => {
	it('reads the profile and access with the caller’s own credential', async () => {
		mocks.get.mockImplementation(async ({ collection }: { collection: string }) =>
			collection === 'group.opensocial.profile'
				? { value: { displayName: 'Quiet' } }
				: { value: { public: false } }
		);
		expect(await readMetaAsPerson(caller([]), 'did:plc:g')).toEqual({
			profile: { name: 'Quiet', description: null },
			public: false
		});
	});
});

describe('membership', () => {
	it('is the caller’s own membership record, which a member may read', async () => {
		mocks.get.mockResolvedValueOnce({ value: {} });
		expect(await isMemberAsPerson(caller([]), 'did:plc:g')).toBe(true);
		expect(mocks.get).toHaveBeenCalledWith(
			expect.objectContaining({ collection: 'group.opensocial.membership', rkey: ALICE })
		);
		mocks.get.mockResolvedValueOnce(null);
		expect(await isMemberAsPerson(caller([]), 'did:plc:g')).toBe(false);
	});

	it('reads a refusal as not a member, and anything else as an error', async () => {
		mocks.get.mockRejectedValueOnce(new SpaceAccessDenied('s', '400 SpaceNotFound', true));
		expect(await isMemberAsPerson(caller([]), 'did:plc:g')).toBe(false);
		mocks.get.mockRejectedValueOnce(new Error('down'));
		await expect(isMemberAsPerson(caller([]), 'did:plc:g')).rejects.toThrow('down');
	});

	it('lists only groups the host confirms, leaving out one it cannot answer for', async () => {
		const c = caller([
			{ spaces: [space('did:plc:in'), space('did:plc:out'), space('did:plc:down')] }
		]);
		mocks.get.mockImplementation(async ({ space: s, collection }: Record<string, string>) => {
			if (s.includes('did:plc:down')) throw new Error('down');
			if (collection === 'group.opensocial.membership') {
				return s.includes('did:plc:in') ? { value: {} } : null;
			}
			return { value: collection === 'group.opensocial.access' ? { public: true } : {} };
		});
		expect((await groupsOfPerson(c)).map((g) => g.did)).toEqual(['did:plc:in']);
	});
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authzRecords } from './__fixtures__/host-records';
import { recordsReader } from './__fixtures__/space-reader';
import type { GroupSpaceReader } from './space-read';

const GROUP = 'did:plc:group';
const ADMIN = 'did:plc:admin';
const MEMBER = 'did:plc:member';
const NEW = 'did:plc:new';

const mocks = vi.hoisted(() => ({
	reader: null as unknown as GroupSpaceReader,
	accepted: vi.fn(),
	accept: vi.fn()
}));
vi.mock('./space-read', () => ({ credentialSpaceReader: () => mocks.reader }));
vi.mock('./space-credential', async (importActual) => ({
	...(await importActual<typeof import('./space-credential')>()),
	credentialAcceptanceReader: () => ({ accepted: mocks.accepted })
}));
vi.mock('./acceptance', () => ({ accept: mocks.accept }));

import { readRoster } from './roster';
import { readGroupMembers, splitRoster } from './members-read';

const caller = (did: string) => ({ did, scope: '', handle: vi.fn() });
const roster = { [ADMIN]: 'admin', [MEMBER]: 'member', [NEW]: 'member' } as const;

beforeEach(() => {
	vi.resetAllMocks();
	mocks.reader = recordsReader(GROUP, authzRecords(GROUP, roster));
	mocks.accepted.mockResolvedValue(
		new Map([
			[ADMIN, true],
			[MEMBER, true],
			[NEW, false]
		])
	);
	mocks.accept.mockResolvedValue(true);
});

describe('readRoster', () => {
	it('gives an admin the permissions the records grant, and lists who confirmed', async () => {
		const result = await readRoster(caller(ADMIN), GROUP);
		expect(result.role).toBe('admin');
		expect(result.permissions).toContain('ADMIT_MEMBERS');
		const { listed, unconfirmed } = splitRoster(result.entries);
		expect(listed.map((e) => e.did).sort()).toEqual([ADMIN, MEMBER].sort());
		expect(unconfirmed.map((e) => e.did)).toEqual([NEW]);
		expect(mocks.accept).not.toHaveBeenCalled();
	});

	it('confirms a member who had not, on their own visit', async () => {
		const result = await readRoster(caller(NEW), GROUP);
		expect(mocks.accept).toHaveBeenCalledWith(expect.objectContaining({ did: NEW }), GROUP);
		expect(result.entries.find((e) => e.did === NEW)?.confirmed).toBe(true);
		expect(result.permissions).toEqual([]);
	});

	it('lists everyone, as unknown, when acceptances cannot be read', async () => {
		mocks.accepted.mockRejectedValue(new Error('down'));
		const result = await readRoster(caller(MEMBER), GROUP);
		expect(result.entries.every((e) => e.confirmed === null)).toBe(true);
		expect(splitRoster(result.entries).listed).toHaveLength(3);
		expect(mocks.accept).not.toHaveBeenCalled();
	});
});

describe('readGroupMembers', () => {
	it('turns no other record into a membership, though the host ignored the filter', async () => {
		const reader = recordsReader(GROUP, authzRecords(GROUP, { [ADMIN]: 'admin' }), {
			ignoreCollectionFilter: true
		});
		const members = await readGroupMembers(reader, GROUP);
		expect(members.memberships.map((m) => m.subject)).toEqual([ADMIN]);
		expect(members.roles).toEqual(['admin', 'member']);
		expect(members.access).not.toBeNull();
	});
});

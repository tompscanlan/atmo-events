import { describe, expect, it, vi } from 'vitest';
import { SpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import type { SpaceReader } from '#lib/spaces/server/space-read.js';
import { isMemberAsPerson, readMetaAsPerson, readRolesAsPerson } from './person';

const GROUP = 'did:plc:group';
const ALICE = 'did:plc:alice';
const META = `at:space/${GROUP}/org.atgrp.meta/self`;
const MEMBERS = `at:space/${GROUP}/org.atgrp.members/self`;

/** A reader holding `records`, keyed by space and collection then rkey; `refuse` denies a space. */
function reader(
	records: Record<string, Record<string, unknown>>,
	refuse: Record<string, Error> = {}
): SpaceReader & { get: ReturnType<typeof vi.fn> } {
	return {
		get: vi.fn(async ({ space, collection, rkey }) => {
			if (refuse[space]) throw refuse[space];
			const value = records[`${space} ${collection}/${rkey}`];
			return value ? { uri: 'u', cid: 'c', rkey, value } : null;
		}),
		writers: vi.fn(),
		blob: vi.fn()
	};
}

describe('a group read with the person’s own access', () => {
	it('reads its about record, config and published policy from the meta space', async () => {
		const read = reader({
			[`${META} org.atgrp.about/self`]: { displayName: 'Knitters', description: 'Yarn' },
			[`${META} org.atgrp.config/self`]: { joinPolicy: 'open' },
			[`${META} com.atproto.space.policy/self`]: { policy: { publicRead: false } }
		});
		expect(await readMetaAsPerson(read, GROUP)).toEqual({
			profile: { name: 'Knitters', description: 'Yarn' },
			public: false,
			joinPolicy: 'open'
		});
		expect(read.get).toHaveBeenCalledWith({
			space: META,
			repo: GROUP,
			collection: 'org.atgrp.config',
			rkey: 'self'
		});
	});

	it('reads a group with no config, or one the spec does not name, as approving its members, as the host does', async () => {
		expect((await readMetaAsPerson(reader({}), GROUP)).joinPolicy).toBe('approval');
		const odd = reader({ [`${META} org.atgrp.config/self`]: { joinPolicy: 'closed' } });
		expect((await readMetaAsPerson(odd, GROUP)).joinPolicy).toBe('approval');
	});

	it('throws when the host does not let them read it', async () => {
		const denied = new SpaceAccessDenied(META, '400 NotAuthorized');
		await expect(readMetaAsPerson(reader({}, { [META]: denied }), GROUP)).rejects.toBe(denied);
	});
});

describe('whether the person is a member', () => {
	it('reads their membership in the members space, keyed by their DID', async () => {
		const read = reader({
			[`${MEMBERS} org.atgrp.membership/${ALICE}`]: { roles: ['member'], createdAt: 'now' }
		});
		expect(await isMemberAsPerson(read, GROUP, ALICE)).toBe(true);
		expect(await isMemberAsPerson(read, GROUP, 'did:plc:bob')).toBe(false);
	});

	it("keys a did:web with a port by the host's form, its colon unescaped", async () => {
		const web = 'did:web:pds.example%3A8443';
		const read = reader({
			[`${MEMBERS} org.atgrp.membership/did:web:pds.example:8443`]: { roles: ['member'] }
		});
		expect(await isMemberAsPerson(read, GROUP, web)).toBe(true);
	});

	it('is not a member when the host keeps them out of the members space, and throws on an outage', async () => {
		const denied = new SpaceAccessDenied(MEMBERS, '400 NotAuthorized');
		expect(await isMemberAsPerson(reader({}, { [MEMBERS]: denied }), GROUP, ALICE)).toBe(false);
		const down = reader({}, { [MEMBERS]: new Error('host down') });
		await expect(isMemberAsPerson(down, GROUP, ALICE)).rejects.toThrow('host down');
	});

	it('cannot tell from SpaceNotFound, which a PDS also answers when it could not reach the host', async () => {
		const unclear = new SpaceAccessDenied(MEMBERS, '400 SpaceNotFound');
		await expect(isMemberAsPerson(reader({}, { [MEMBERS]: unclear }), GROUP, ALICE)).rejects.toBe(
			unclear
		);
	});
});

describe("the person's own roles", () => {
	it('are read from their membership, and null without one', async () => {
		const read = reader({
			[`${MEMBERS} org.atgrp.membership/${ALICE}`]: { roles: ['member', 'admin'], createdAt: 'now' }
		});
		expect(await readRolesAsPerson(read, GROUP, ALICE)).toEqual(['member', 'admin']);
		expect(await readRolesAsPerson(read, GROUP, 'did:plc:bob')).toBeNull();
		const odd = reader({ [`${MEMBERS} org.atgrp.membership/${ALICE}`]: { roles: 'admin' } });
		expect(await readRolesAsPerson(odd, GROUP, ALICE)).toBeNull();
	});
});

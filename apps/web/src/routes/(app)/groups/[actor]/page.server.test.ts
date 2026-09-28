import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// What the group page shows as the group's visibility: the badge and the
// settings form's selected value. It is the host's answer, the about space's
// read policy, for every caller, including the owner, whom the gate itself
// never asks about. The handle cache and the resolver are stubbed because
// neither decides anything here, and the space reader is a fake host whose read
// policy each case sets.
vi.mock('$lib/groups/server/handles', () => ({
	refreshGroupHandle: vi.fn(async () => null)
}));
vi.mock('$lib/groups/server/about-read', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/about-read')>()),
	groupSpaceReader: vi.fn()
}));
vi.mock('$lib/atproto/methods', () => ({ actorToDid: vi.fn() }));

import { load } from './+page.server';
import { groupSpaceReader, type GroupSpaceReader } from '$lib/groups/server/about-read';
import { sqliteD1, type SqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { addMember, createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupSpaceUris } from '$lib/groups/server/spaces';

const OWNER = 'did:plc:owner';
const MEMBER = 'did:plc:member';
const STRANGER = 'did:plc:stranger';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;

beforeEach(async () => {
	harness = sqliteD1();
	const row = await createGroup(harness.db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await recordGroupSpaces(harness.db, row.id, groupSpaceUris(GROUP_DID));
	await addMember(harness.db, row.id, MEMBER, 'member');
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
});

/** A host whose spaces hold no records and whose about space reports
 *  `readPolicy`, or fails with it. No records means no authz config, so a
 *  roster caller's standing comes from the rows and the gate admits them
 *  without asking the host. */
function hostReading(readPolicy: string | Error): GroupSpaceReader & { asked: string[] } {
	const asked: string[] = [];
	return {
		asked,
		async get() {
			return null;
		},
		async list() {
			return [];
		},
		async getSpace(space) {
			asked.push(space);
			if (readPolicy instanceof Error) throw readPolicy;
			return { readPolicy };
		}
	};
}

async function openAs(did: string | null) {
	return (await load({
		params: { actor: GROUP_DID },
		locals: { did },
		platform: { env: { DB: harness.db } }
	} as unknown as Parameters<typeof load>[0])) as {
		visibility: string | null;
		about: { joinPolicy: string };
	};
}

describe('/groups/[actor] load', () => {
	it('the group page loads the visibility its host reports', async () => {
		for (const [policy, visibility, joinPolicy] of [
			['com.atproto.simplespace.defs#publicPolicy', 'public', 'approval'],
			['com.atproto.simplespace.defs#memberListPolicy', 'private', 'invite']
		] as const) {
			const host = hostReading(policy);
			vi.mocked(groupSpaceReader).mockResolvedValue(host);

			const data = await openAs(OWNER);

			expect(data.visibility).toBe(visibility);
			expect(host.asked).toEqual([ABOUT]);
			// No profile record, so the join policy falls back to the row's
			// approval and the host's visibility.
			expect(data.about.joinPolicy).toBe(joinPolicy);
		}
	});

	// A caller off the roster was already gated on the host's answer, so the
	// page shows that one and does not ask again.
	it("a stranger's page reuses the gate's answer and asks the host once", async () => {
		const host = hostReading('com.atproto.simplespace.defs#publicPolicy');
		vi.mocked(groupSpaceReader).mockResolvedValue(host);

		const data = await openAs(STRANGER);

		expect(data.visibility).toBe('public');
		expect(host.asked).toEqual([ABOUT]);
	});

	// The gate never asks the host for a member, so a host that is down cannot
	// lock them out; the page asks only to show the visibility. When it cannot
	// say, the page still renders, with no visibility, and the join policy
	// fails closed.
	it("a member's page loads with no visibility when the host cannot say", async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		vi.mocked(groupSpaceReader).mockResolvedValue(hostReading(new Error('getSpace failed: 502')));

		const data = await openAs(MEMBER);

		expect(data.visibility).toBeNull();
		expect(data.about.joinPolicy).toBe('invite');
		expect(logged).toHaveBeenCalled();
		logged.mockRestore();
	});

	it("an owner's page loads with no visibility when the deployment holds no credential", async () => {
		vi.mocked(groupSpaceReader).mockResolvedValue(null);

		const data = await openAs(OWNER);

		expect(data.visibility).toBeNull();
	});
});

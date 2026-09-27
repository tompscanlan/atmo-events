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
import { createGroup, recordGroupSpaces } from '$lib/groups/server/repo';
import { groupSpaceUris } from '$lib/groups/server/spaces';

const OWNER = 'did:plc:owner';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const { aboutSpaceUri: ABOUT } = groupSpaceUris(GROUP_DID);

let harness: SqliteD1;

beforeEach(async () => {
	harness = sqliteD1();
	const row = await createGroup(harness.db, { groupDid: GROUP_DID, ownerDid: OWNER, name: 'Kona' });
	await recordGroupSpaces(harness.db, row.id, groupSpaceUris(GROUP_DID));
});

afterEach(() => {
	harness.close();
	vi.clearAllMocks();
});

/** A host whose spaces hold no records and whose about space reports
 *  `readPolicy`. No records means no authz config, so the owner's standing
 *  comes from the rows and the gate admits them without asking the host. */
function hostReading(readPolicy: string): GroupSpaceReader & { asked: string[] } {
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
			return { readPolicy };
		}
	};
}

async function openAs(did: string) {
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
});

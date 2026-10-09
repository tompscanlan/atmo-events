// The link routes. The start answers a non-owner with the same 404 as a missing
// group, and the callback never touches the browser's cookies: the sign-in
// callback sets `did` to whoever authorized, which here would be the group.
//
// The OAuth client and its state store are stubbed (they talk to the group's
// PDS); the groups table is the real SQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';

let authorizedAs: string;
const states = new Map<string, StoredState>();

vi.mock('$lib/atproto/server/oauth', () => ({
	oauthStates: () => ({
		get: async (key: string) => states.get(key),
		delete: async (key: string) => {
			states.delete(key);
		}
	})
}));
vi.mock('$lib/groups/server/session', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/session')>()),
	groupLinkClient: () => ({
		authorize: async () => ({ url: new URL('https://pds.test/oauth/authorize'), stateId: 's' }),
		callback: async () => ({ session: { did: authorizedAs } }),
		revoke: async () => {}
	})
}));

import { POST } from './+server';
import { GET } from './callback/+server';
import { sqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { createGroup } from '$lib/groups/server/repo';

const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';

let db: D1Database;

beforeEach(async () => {
	db = sqliteD1().db;
	await createGroup(db, { groupDid: GROUP, ownerDid: OWNER, name: 'Kona Trail Runners' });
	authorizedAs = GROUP;
	states.clear();
});

const env = (): Record<string, unknown> => ({
	DB: db,
	OAUTH_PUBLIC_URL: 'https://atmo.test',
	OAUTH_SESSIONS: {} as KVNamespace
});

async function thrown(run: () => unknown): Promise<{ status: number; location?: string }> {
	try {
		await run();
	} catch (e) {
		return e as { status: number; location?: string };
	}
	throw new Error('expected the handler to answer with a redirect or an error');
}

function start(did: string | null, platformEnv = env()) {
	const body = new FormData();
	body.set('groupDid', GROUP);
	return thrown(() =>
		POST({
			request: new Request('https://atmo.test/oauth/group-link', { method: 'POST', body }),
			locals: { did },
			platform: { env: platformEnv }
		} as unknown as Parameters<typeof POST>[0])
	);
}

function callback(did: string | null) {
	const cookies = {
		set: vi.fn(),
		delete: vi.fn(),
		get: vi.fn(),
		getAll: vi.fn(),
		serialize: vi.fn()
	};
	const result = thrown(() =>
		GET({
			url: new URL('https://atmo.test/oauth/group-link/callback?state=s1&code=c'),
			locals: { did },
			cookies,
			platform: { env: env() }
		} as unknown as Parameters<typeof GET>[0])
	);
	return { result, cookies };
}

describe('POST /oauth/group-link', () => {
	it('sends the owner to the group’s PDS', async () => {
		expect(await start(OWNER)).toMatchObject({
			status: 303,
			location: 'https://pds.test/oauth/authorize'
		});
	});

	it('answers a member who is not the owner as if the group did not exist', async () => {
		expect(await start(MEMBER)).toMatchObject({ status: 404 });
	});

	// A link kept nowhere would be lost with the request that made it.
	it('refuses on a deployment with no sessions store', async () => {
		const noStore = env();
		delete noStore.OAUTH_SESSIONS;
		expect(await start(OWNER, noStore)).toMatchObject({ status: 501 });
	});
});

describe('GET /oauth/group-link/callback', () => {
	it('links the group and leaves the browser signed in as the owner', async () => {
		states.set('s1', { userState: { groupDid: GROUP, by: OWNER } } as unknown as StoredState);
		const { result, cookies } = callback(OWNER);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=linked` });
		expect(cookies.set).not.toHaveBeenCalled();
		expect(cookies.delete).not.toHaveBeenCalled();
	});

	it('sends a refused link back to the group page, with no cookie set either', async () => {
		states.set('s1', { userState: { groupDid: GROUP, by: OWNER } } as unknown as StoredState);
		authorizedAs = OWNER;
		const { result, cookies } = callback(OWNER);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=failed` });
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

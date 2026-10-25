import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';

let authorizedAs: string;
const states = new Map<string, StoredState>();
const authorize = vi.hoisted(() => vi.fn());
/** Whose client each call built, in order. */
const clientsFor = vi.hoisted(() => [] as string[]);
/** Each caller's role in the group. */
const roles = vi.hoisted(() => new Map<string, string>());
const isHostGroup = vi.hoisted(() => vi.fn());

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
	groupLinkClient: (_env: unknown, personDid: string) => {
		clientsFor.push(personDid);
		return {
			authorize,
			callback: async () => ({ session: { did: authorizedAs } }),
			revoke: async () => {}
		};
	}
}));
vi.mock('$lib/groups/server/host', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/host')>()),
	isHostGroup
}));
vi.mock('$lib/groups/server/caller', () => ({
	gateCaller: async (did: string | null) => (did ? { did } : null)
}));
vi.mock('$lib/groups/server/route-context', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/groups/server/route-context')>();
	const { error } = await import('@sveltejs/kit');
	const { getGroupByDid } = await import('$lib/groups/server/db/groups');
	const { memberGrants } = await import('$lib/groups/grants');
	const { HOST_PERMISSIONS } = await import('$lib/groups/server/__fixtures__/members-space');
	return {
		...actual,
		groupRouteContext: async (db: D1Database, actor: string, caller: { did: string } | null) => {
			const group = await getGroupByDid(db, actor);
			if (!group) error(404, actual.GROUP_NOT_FOUND);
			const role = caller ? roles.get(caller.did) : undefined;
			const grants = memberGrants({
				roles: role ? [role] : [],
				permissions: HOST_PERMISSIONS.grants
			});
			return { group, membership: { grants }, visibility: null, reader: null };
		}
	};
});

import { POST } from './+server';
import { GET } from './callback/+server';
import { sqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';
import { createGroup } from '$lib/groups/server/db/groups';

const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const ADMIN = 'did:plc:adminaaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';

let db: D1Database;

beforeEach(async () => {
	db = sqliteD1().db;
	await createGroup(db, { groupDid: GROUP, creatorDid: ADMIN, name: 'Kona Trail Runners' });
	authorizedAs = GROUP;
	states.clear();
	clientsFor.length = 0;
	roles.clear();
	roles.set(ADMIN, 'admin');
	roles.set(MEMBER, 'member');
	authorize.mockReset();
	authorize.mockResolvedValue({ url: new URL('https://pds.test/oauth/authorize'), stateId: 's' });
	isHostGroup.mockReset();
	isHostGroup.mockResolvedValue(true);
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

function start(did: string | null, platformEnv = env(), groupDid: string | null = GROUP) {
	const body = new FormData();
	if (groupDid !== null) body.set('groupDid', groupDid);
	return thrown(() =>
		POST({
			request: new Request('https://atmo.test/oauth/group-link', { method: 'POST', body }),
			locals: { did },
			platform: { env: platformEnv }
		} as unknown as Parameters<typeof POST>[0])
	);
}

function callback(did: string | null) {
	const cookies = { set: vi.fn(), delete: vi.fn(), get: vi.fn() };
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
	it("sends someone whose roles grant writes to the group's PDS, on their own client", async () => {
		const answer = await start(ADMIN);
		expect(answer.status).toBe(303);
		expect(new URL(answer.location ?? '').searchParams.get('gh_person')).toBe(ADMIN);
		expect(clientsFor).toEqual([ADMIN]);
	});

	it.each([
		['a member whose roles grant no writes', MEMBER, GROUP, 404],
		['a signed-out caller', null, GROUP, 401],
		['an unknown group', ADMIN, 'did:plc:unknowngroupaaaaaaaaaaaa', 404],
		['no group at all', ADMIN, null, 404]
	])('answers %s without starting a link', async (_, did, groupDid, status) => {
		expect(await start(did, env(), groupDid)).toMatchObject({ status });
		expect(authorize).not.toHaveBeenCalled();
	});

	it('answers a group at another host with the 404', async () => {
		isHostGroup.mockResolvedValue(false);
		expect(await start(ADMIN)).toMatchObject({ status: 404 });
		expect(authorize).not.toHaveBeenCalled();
	});

	it('refuses on a deployment with no sessions store', async () => {
		const noStore = env();
		delete noStore.OAUTH_SESSIONS;
		expect(await start(ADMIN, noStore)).toMatchObject({ status: 501 });
	});
});

describe('GET /oauth/group-link/callback', () => {
	beforeEach(() => {
		states.set('s1', { userState: { groupDid: GROUP, by: ADMIN } } as unknown as StoredState);
	});

	it('files the session under the person who started it, and sets no cookie', async () => {
		const { result, cookies } = callback(ADMIN);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=linked` });
		expect(clientsFor).toEqual([ADMIN]);
		expect(cookies.set).not.toHaveBeenCalled();
		expect(cookies.delete).not.toHaveBeenCalled();
	});

	it('refuses a link whose starter no longer holds a role that writes', async () => {
		roles.set(ADMIN, 'member');
		const { result } = callback(ADMIN);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=failed` });
		expect(clientsFor).toEqual([]);
	});

	it('refuses a session that came back for an account other than the group', async () => {
		authorizedAs = ADMIN;
		const { result, cookies } = callback(ADMIN);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=failed` });
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

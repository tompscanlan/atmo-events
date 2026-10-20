// The link routes. The start answers someone whose roles grant no writes with
// the same 404 as a missing group, each link runs on the client of the person
// who started it, which files the session under them, and the callback never
// touches the browser's cookies: the sign-in callback sets `did` to whoever
// authorized, which here would be the group.
//
// The OAuth client and its state store are stubbed (they talk to the group's
// PDS), and so is the caller's standing, which the route reads as every group
// route does (route-context.test.ts covers that read); the groups table is the
// real SQL.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoredState } from '@atcute/oauth-node-client';

let authorizedAs: string;
const states = new Map<string, StoredState>();
const authorize = vi.hoisted(() => vi.fn());
/** Whose client each call built, in order. */
const clientsFor = vi.hoisted(() => [] as string[]);
/** The named permissions each caller's roles grant. */
const roles = vi.hoisted(() => new Map<string, string[]>());

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
/** Whether a group lives at the deployment's group host (it resolves the DID). */
const isHostGroup = vi.hoisted(() => vi.fn());
vi.mock('$lib/groups/server/host-kind', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/groups/server/host-kind')>()),
	isHostGroup
}));
vi.mock('$lib/groups/server/acceptance', () => ({
	gateCaller: async (did: string | null) => (did ? { did } : null)
}));
vi.mock('$lib/groups/server/route-context', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$lib/groups/server/route-context')>();
	const { error } = await import('@sveltejs/kit');
	const { getGroupByDid } = await import('$lib/groups/server/db/groups');
	const { NO_GRANTS } = await import('$lib/groups/scopes');
	return {
		...actual,
		groupRouteContext: async (db: D1Database, actor: string, caller: { did: string } | null) => {
			const group = await getGroupByDid(db, actor);
			if (!group) error(404, actual.GROUP_NOT_FOUND);
			const permissions = new Set(caller ? (roles.get(caller.did) ?? []) : []);
			return {
				group,
				membership: { permissions, grants: NO_GRANTS },
				visibility: null,
				reader: null
			};
		}
	};
});

import { POST } from './+server';
import { GET } from './callback/+server';
import { sqliteD1 } from '$lib/groups/server/__fixtures__/d1-sqlite';

import { createGroup } from '$lib/groups/server/db/groups';
const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const OWNER = 'did:plc:owneraaaaaaaaaaaaaaaaaaa';
const MEMBER = 'did:plc:memberaaaaaaaaaaaaaaaaaa';
const ADMIN = 'did:plc:adminaaaaaaaaaaaaaaaaaaa';

let db: D1Database;

beforeEach(async () => {
	db = sqliteD1().db;
	await createGroup(db, { groupDid: GROUP, ownerDid: OWNER, name: 'Kona Trail Runners' });
	authorizedAs = GROUP;
	states.clear();
	clientsFor.length = 0;
	roles.clear();
	roles.set(OWNER, ['MANAGE_GROUP', 'CREATE_EVENT']);
	roles.set(ADMIN, ['ADMIT_MEMBERS']);
	roles.set(MEMBER, []);
	authorize.mockReset();
	authorize.mockResolvedValue({ url: new URL('https://pds.test/oauth/authorize'), stateId: 's' });
	isHostGroup.mockReset();
	isHostGroup.mockResolvedValue(false);
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
	it('sends anyone whose roles grant writes to the group’s PDS, on their own client', async () => {
		for (const did of [OWNER, ADMIN]) {
			expect(await start(did)).toMatchObject({
				status: 303,
				location: 'https://pds.test/oauth/authorize'
			});
		}
		expect(clientsFor).toEqual([OWNER, ADMIN]);
	});

	it('answers a member whose roles grant no writes as if the group did not exist', async () => {
		expect(await start(MEMBER)).toMatchObject({ status: 404 });
		expect(authorize).not.toHaveBeenCalled();
	});

	// Nobody signed in has roles, so the link never starts: no request goes to
	// any PDS.
	it('asks a signed-out caller to sign in, and starts nothing', async () => {
		expect(await start(null)).toMatchObject({ status: 401 });
		expect(authorize).not.toHaveBeenCalled();
	});

	it('answers a group this site does not know, or no group at all, with the 404', async () => {
		expect(await start(OWNER, env(), 'did:plc:unknowngroupaaaaaaaaaaaa')).toMatchObject({
			status: 404
		});
		expect(await start(OWNER, env(), null)).toMatchObject({ status: 404 });
		expect(authorize).not.toHaveBeenCalled();
	});

	// The group host's act-for-group page fills in the person's handle from the
	// hint; a PDS this site does not know as its host is never told who the
	// person is.
	it('hints the person to the group host only for a group that lives there', async () => {
		const withHost = { ...env(), GROUP_HOST_URL: 'https://grouphost.test' };

		isHostGroup.mockResolvedValueOnce(true);
		const hinted = new URL((await start(ADMIN, withHost)).location ?? '');
		expect(hinted.searchParams.get('gh_person')).toBe(ADMIN);
		expect(hinted.searchParams.get('gh_name')).toBeNull();
		expect(isHostGroup).toHaveBeenLastCalledWith(withHost, GROUP);

		isHostGroup.mockResolvedValueOnce(false);
		const plain = new URL((await start(ADMIN, withHost)).location ?? '');
		expect([...plain.searchParams.keys()]).toEqual([]);
	});

	// A link kept nowhere would be lost with the request that made it.
	it('refuses on a deployment with no sessions store', async () => {
		const noStore = env();
		delete noStore.OAUTH_SESSIONS;
		expect(await start(OWNER, noStore)).toMatchObject({ status: 501 });
	});
});

describe('GET /oauth/group-link/callback', () => {
	it('files the session under the person who started it, and leaves the browser signed in as them', async () => {
		states.set('s1', { userState: { groupDid: GROUP, by: ADMIN } } as unknown as StoredState);
		const { result, cookies } = callback(ADMIN);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=linked` });
		expect(clientsFor).toEqual([ADMIN]);
		expect(cookies.set).not.toHaveBeenCalled();
		expect(cookies.delete).not.toHaveBeenCalled();
	});

	it('refuses a link whose starter’s roles no longer grant writes', async () => {
		states.set('s1', { userState: { groupDid: GROUP, by: ADMIN } } as unknown as StoredState);
		roles.set(ADMIN, []);
		const { result } = callback(ADMIN);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=failed` });
		expect(clientsFor).toEqual([]);
	});

	it('sends a refused link back to the group page, with no cookie set either', async () => {
		states.set('s1', { userState: { groupDid: GROUP, by: OWNER } } as unknown as StoredState);
		authorizedAs = OWNER;
		const { result, cookies } = callback(OWNER);
		expect(await result).toMatchObject({ status: 303, location: `/groups/${GROUP}?link=failed` });
		expect(cookies.set).not.toHaveBeenCalled();
	});
});

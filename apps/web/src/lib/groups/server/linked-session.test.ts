// Which credential the seam writes with. A group whose owner linked its account
// writes through that session and nothing else; a group nobody linked has no
// credential at all. The log names which credential served each write.
//
// Restoring a session talks to the group's PDS, so the OAuth client is the stub
// here. The store lookup and the transport are the real code.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let sessionDid: string;
let handled: { pathname: string; method: string }[];
const restored: string[] = [];

vi.mock('$lib/atproto/server/oauth', () => ({
	createOAuthClientFor: vi.fn(() => ({
		restore: async (did: string) => {
			restored.push(did);
			return {
				did: sessionDid,
				handle: async (pathname: string, init?: RequestInit) => {
					handled.push({ pathname, method: (init?.method ?? 'GET').toUpperCase() });
					return Response.json({ uri: `at://${sessionDid}/c/r1`, cid: 'bafylinked' });
				}
			};
		}
	}))
}));

import { resolveGroupCredential } from './credentials';

import { GROUP_SESSION_PREFIX, groupSessionScopes, hasLinkedSession } from './linked-session';
import { groupClient } from './session';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';

import { GROUP_EVENT_COLLECTION } from '../ids';
import { pdsWriter } from './group-write';
const GROUP = 'did:plc:linkedgroupaaaaaaaaaaaaa';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';

function fakeKv(entries: Record<string, string>): KVNamespace {
	const map = new Map(Object.entries(entries));
	return {
		get: async (key: string) => map.get(key) ?? null
	} as unknown as KVNamespace;
}

let fetched: string[];
let logged: string[];

beforeEach(() => {
	sessionDid = GROUP;
	handled = [];
	restored.length = 0;
	fetched = [];
	logged = [];
	// Anything that leaves through the global fetch went around the session.
	vi.stubGlobal('fetch', async (input: URL | string) => {
		fetched.push(new URL(String(input)).pathname);
		return Response.json({ error: 'NotExpected' }, { status: 500 });
	});
	vi.spyOn(console, 'info').mockImplementation((line: string) => {
		logged.push(line);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

const write = {
	repo: GROUP,
	collection: GROUP_EVENT_COLLECTION,
	rkey: 'r1',
	record: { name: 'Kona weekly ride' },
	intent: 'create' as const
};

describe('the session seam', () => {
	it('writes through the linked session when the group has one, and nothing else', async () => {
		const env = { OAUTH_SESSIONS: fakeKv({ [GROUP_SESSION_PREFIX + GROUP]: '{}' }) };
		const cred = await resolveGroupCredential(env, GROUP);
		expect(cred?.kind).toBe('linked');

		const result = await pdsWriter(cred!, GROUP)(write);

		expect(result.cid).toBe('bafylinked');
		expect(handled).toEqual([{ pathname: '/xrpc/com.atproto.repo.createRecord', method: 'POST' }]);
		expect(fetched).toEqual([]);
		expect(logged).toEqual([
			`[group-session] ${GROUP} com.atproto.repo.createRecord via linked: 200`
		]);
	});

	it('has no credential for a group that is not linked, and a sign-in as the group is not a link', async () => {
		// A sign-in session sits under the bare DID. It lacks the group's scope,
		// so it must not stand in for a link.
		const env = { OAUTH_SESSIONS: fakeKv({ [GROUP]: '{}' }) };
		expect(await hasLinkedSession(env as unknown as App.Platform['env'], GROUP)).toBe(false);

		await expect(resolveGroupCredential(env, GROUP)).resolves.toBeNull();
		expect(restored).toEqual([]);
		expect(fetched).toEqual([]);
	});

	it('refuses a linked session that authenticates another account', async () => {
		sessionDid = OTHER;
		const env = { OAUTH_SESSIONS: fakeKv({ [GROUP_SESSION_PREFIX + GROUP]: '{}' }) };
		const cred = await resolveGroupCredential(env, GROUP);
		await expect(groupClient(cred!, GROUP)).rejects.toThrow(/authenticates .*someoneelse/);
		expect(handled).toEqual([]);
	});
});

describe('the scope a link asks for', () => {
	it('covers every public-repo collection the group writes, and only the group’s own spaces', () => {
		const scopes = groupSessionScopes();
		const repo = scopes.find((s) => s.startsWith('repo'));
		expect(repo).toContain(GROUP_EVENT_COLLECTION);
		expect(repo).toContain(GROUP_DECLARATION_COLLECTION);
		const spaces = scopes.filter((s) => s.startsWith('space:'));
		expect(spaces.length).toBeGreaterThan(0);
		for (const s of spaces) expect(s).toContain('authority=self');
	});
});

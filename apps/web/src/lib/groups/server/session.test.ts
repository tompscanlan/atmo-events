// Writing as a group: where the credential comes from, and the two transports
// behind the one seam.
//
// The only lasting credential is the session the group's owner linked. The store
// is read for real; the OAuth client that restores a session is the fixture's
// (./__fixtures__/linked-group.ts), which sends each request through the global
// `fetch` with its own token, so a request it served is one that carries it.
//
// The session `createAccount` returns serves only the create request that minted
// the account. It is sent as it is: there is no password to log in again with
// and no refresh to attempt, so a rejected token is the PDS's answer and comes
// back untouched. A linked session renews its own tokens inside the OAuth client,
// so the seam only checks whose session it is and reports each write.
//
// Every write logs which credential served it, never the token.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	GROUP_SESSION_PREFIX,
	GROUP_SESSION_SCOPES,
	groupClient,
	resolveGroupCredential,
	type LinkedGroupCredential,
	type MintSessionCredential
} from './session';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';
import { GROUP_EVENT_COLLECTION } from '../ids';

const DID = 'did:plc:sessiontestgroup0000000';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';
const TOKEN = 'mint-access-token';
const PATH = '/xrpc/com.atproto.space.getRecord?space=s&repo=r';
const WRITE = '/xrpc/com.atproto.repo.createRecord';

/** A sessions namespace holding exactly `keys`. */
function kv(keys: string[]): KVNamespace {
	return {
		get: async (key: string) => (keys.includes(key) ? '{}' : null)
	} as unknown as KVNamespace;
}

const minted: MintSessionCredential = {
	kind: 'mint-session',
	service: 'https://pds.stub.test',
	did: DID,
	accessJwt: TOKEN
};

let calls: { url: URL; token: string | null }[];
let reply: () => Response;
let logged: string[];

beforeEach(() => {
	calls = [];
	logged = [];
	reply = () => Response.json({ ok: true });
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null;
		calls.push({ url, token });
		return reply();
	});
	vi.spyOn(console, 'info').mockImplementation((line: string) => {
		logged.push(line);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	unlinkAllGroups();
});

describe('groupClient: the minted session', () => {
	it('sends its access token to the service it was minted on', async () => {
		const { handle } = await groupClient(minted, DID);

		const res = await handle(PATH, { method: 'GET' });

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0].url.origin).toBe('https://pds.stub.test');
		expect(calls[0].url.pathname).toBe('/xrpc/com.atproto.space.getRecord');
		expect(calls[0].token).toBe(TOKEN);
	});

	it('refuses a session minted for another account, before any request', async () => {
		await expect(groupClient({ ...minted, did: OTHER }, DID)).rejects.toThrow(
			/authenticates .*someoneelse/
		);
		expect(calls).toEqual([]);
	});

	// No refreshSession and no createSession: nothing here can renew it.
	it('returns an expired token untouched, with no retry and no login', async () => {
		reply = () => Response.json({ error: 'ExpiredToken' }, { status: 400 });
		const { handle } = await groupClient(minted, DID);

		const res = await handle(PATH, { method: 'GET' });

		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toBe('ExpiredToken');
		expect(calls.map((c) => c.url.pathname)).toEqual(['/xrpc/com.atproto.space.getRecord']);
	});

	it('logs each write as served by the minted session, never the token, and no read', async () => {
		const { handle } = await groupClient(minted, DID);

		await handle(PATH, { method: 'GET' });
		await handle(WRITE, { method: 'POST', body: '{}' });

		expect(logged).toEqual([
			`[group-session] ${DID} com.atproto.repo.createRecord via mint-session: 200`
		]);
		expect(logged.join('\n')).not.toContain(TOKEN);
	});
});

describe('groupClient: the linked session', () => {
	function linked(did: string): LinkedGroupCredential {
		return {
			kind: 'linked',
			session: {
				did: did as LinkedGroupCredential['session']['did'],
				handle: async (pathname: string, init?: RequestInit) => {
					calls.push({ url: new URL(pathname, 'https://pds.stub.test'), token: null });
					return Response.json({ ok: true }, { status: init?.method === 'POST' ? 201 : 200 });
				}
			}
		};
	}

	it('sends through the session', async () => {
		const { handle } = await groupClient(linked(DID), DID);

		await handle(PATH, { method: 'GET' });
		await handle(WRITE, { method: 'POST', body: '{}' });

		expect(calls.map((c) => c.url.pathname)).toEqual([
			'/xrpc/com.atproto.space.getRecord',
			'/xrpc/com.atproto.repo.createRecord'
		]);
	});

	it('refuses a session that authenticates another account, before any request', async () => {
		await expect(groupClient(linked(OTHER), DID)).rejects.toThrow(/authenticates .*someoneelse/);
		expect(calls).toEqual([]);
	});
});

describe('resolveGroupCredential', () => {
	it('is the linked session when the store holds one for the group', async () => {
		const env = linkGroups([DID]);

		const cred = await resolveGroupCredential(env, DID);

		expect(cred?.kind).toBe('linked');
		expect(cred?.kind === 'linked' && cred.session.did).toBe(DID);
	});

	// Nothing else stands in: no stored password, no deployment-wide account.
	it('is null for a group whose owner has not linked it', async () => {
		await expect(resolveGroupCredential(linkGroups([OTHER]), DID)).resolves.toBeNull();
	});

	it('is null on a deployment with no sessions namespace', async () => {
		await expect(resolveGroupCredential({}, DID)).resolves.toBeNull();
	});

	// A sign-in as the group is stored under the bare DID. It lacks the group's
	// scope, so it must not count as a link. The fixture's client throws for a
	// group no test linked, so a restore attempt would fail this case too.
	it('does not take a sign-in session under the bare DID for a link', async () => {
		await expect(resolveGroupCredential({ OAUTH_SESSIONS: kv([DID]) }, DID)).resolves.toBeNull();
	});

	// The owner linked it, so a silent "not linked" would hide a broken session.
	it('fails, rather than answering null, when a stored link cannot be restored', async () => {
		const env = { OAUTH_SESSIONS: kv([GROUP_SESSION_PREFIX + DID]) };

		await expect(resolveGroupCredential(env, DID)).rejects.toThrow(/no linked session/);
	});
});

describe('the scope a link asks for', () => {
	it('covers every public-repo collection the group writes, and only the group’s own spaces', () => {
		const scopes = GROUP_SESSION_SCOPES;
		const repo = scopes.find((s) => s.startsWith('repo'));
		expect(repo).toContain(GROUP_EVENT_COLLECTION);
		expect(repo).toContain(GROUP_DECLARATION_COLLECTION);
		const spaces = scopes.filter((s) => s.startsWith('space:'));
		expect(spaces.length).toBeGreaterThan(0);
		for (const s of spaces) expect(s).toContain('authority=self');
	});
});

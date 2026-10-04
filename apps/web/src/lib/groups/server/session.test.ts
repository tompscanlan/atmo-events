// The two transports behind the one seam.
//
// The session `createAccount` returns serves only the create request that minted
// the account. It is sent as it is: there is no password to log in again with
// and no refresh to attempt, so a rejected token is the PDS's answer and comes
// back untouched. A linked session renews its own tokens inside the OAuth client,
// so the seam only checks whose session it is and reports each write.
//
// Every write logs which credential served it, never the token.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { LinkedGroupCredential, MintSessionCredential } from './credentials';
import { groupClient } from './session';

const DID = 'did:plc:sessiontestgroup0000000';
const OTHER = 'did:plc:someoneelseaaaaaaaaaaaaa';
const TOKEN = 'mint-access-token';
const PATH = '/xrpc/com.atproto.space.getRecord?space=s&repo=r';
const WRITE = '/xrpc/com.atproto.repo.createRecord';

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
	it.each([
		[400, 'ExpiredToken'],
		[400, 'InvalidToken'],
		[401, 'AuthMissing'],
		[400, 'RecordNotFound']
	])('returns %i %s untouched, with no retry and no login', async (status, error) => {
		reply = () => Response.json({ error }, { status });
		const { handle } = await groupClient(minted, DID);

		const res = await handle(PATH, { method: 'GET' });

		expect(res.status).toBe(status);
		expect(((await res.json()) as { error: string }).error).toBe(error);
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

	it('sends through the session and logs each write as served by it', async () => {
		const { handle } = await groupClient(linked(DID), DID);

		await handle(PATH, { method: 'GET' });
		await handle(WRITE, { method: 'POST', body: '{}' });

		expect(calls.map((c) => c.url.pathname)).toEqual([
			'/xrpc/com.atproto.space.getRecord',
			'/xrpc/com.atproto.repo.createRecord'
		]);
		expect(logged).toEqual([
			`[group-session] ${DID} com.atproto.repo.createRecord via linked: 201`
		]);
	});

	it('refuses a session that authenticates another account, before any request', async () => {
		await expect(groupClient(linked(OTHER), DID)).rejects.toThrow(/authenticates .*someoneelse/);
		expect(calls).toEqual([]);
	});
});

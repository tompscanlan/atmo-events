// When the group session renews its token.
//
// A PDS reports a bad access token as 400, not 401: an expired JWT is
// `400 ExpiredToken` and a malformed or unverifiable one is `400 InvalidToken`
// (the reference PDS throws both as InvalidRequestError). Only a request with
// no token at all is a 401. The session is cached per isolate with no expiry of
// its own, so a transport that renewed only on 401 would keep sending the dead
// token for as long as the isolate lived, and every group write and space read
// would fail. A 400 that is not about the token must come back untouched, or a
// missing record would cost a refresh round trip every time.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { clearGroupSessions, groupClient } from './session';

const DID = 'did:plc:sessiontestgroup0000000';
const cred = { service: 'https://pds.stub.test', identifier: 'g.stub.test', password: 'p' };
const PATH = '/xrpc/com.atproto.space.getRecord?space=s&repo=r';

let calls: { nsid: string; token: string | null }[];
let reply: (token: string | null) => Response;

beforeEach(() => {
	calls = [];
	clearGroupSessions();
	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const nsid = url.pathname.replace('/xrpc/', '');
		const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? null;
		calls.push({ nsid, token });
		if (nsid === 'com.atproto.server.createSession') {
			return Response.json({ did: DID, accessJwt: 'access-1', refreshJwt: 'refresh-1' });
		}
		if (nsid === 'com.atproto.server.refreshSession') {
			return Response.json({ did: DID, accessJwt: 'access-2', refreshJwt: 'refresh-2' });
		}
		return reply(token);
	});
});

afterEach(() => vi.unstubAllGlobals());

/** The PDS rejects the first access token with `status`/`error`, and accepts
 *  the renewed one. */
function rejectFirstToken(status: number, error: string) {
	reply = (token) =>
		token === 'access-1'
			? Response.json({ error, message: 'rejected' }, { status })
			: Response.json({ ok: true });
}

const refreshes = () => calls.filter((c) => c.nsid === 'com.atproto.server.refreshSession');

describe('groupClient — renewing the access token', () => {
	it.each([
		[400, 'ExpiredToken'],
		[400, 'InvalidToken'],
		[401, 'AuthMissing']
	])('renews and retries once on %i %s', async (status, error) => {
		rejectFirstToken(status, error);
		const { handle } = await groupClient(cred, DID);

		const res = await handle(PATH, { method: 'GET' });

		expect(res.status).toBe(200);
		expect(refreshes()).toHaveLength(1);
		expect(refreshes()[0].token).toBe('refresh-1');
		expect(calls.at(-1)).toMatchObject({ nsid: 'com.atproto.space.getRecord', token: 'access-2' });
	});

	it('keeps the renewed token for later calls', async () => {
		rejectFirstToken(400, 'ExpiredToken');
		await (await groupClient(cred, DID)).handle(PATH, { method: 'GET' });

		const { handle } = await groupClient(cred, DID);
		await handle(PATH, { method: 'GET' });

		expect(calls.at(-1)).toMatchObject({ token: 'access-2' });
		expect(refreshes()).toHaveLength(1);
	});

	it.each([
		[400, 'RecordNotFound'],
		[400, 'InvalidRequest'],
		[400, undefined]
	])('returns %i %s untouched, without renewing', async (status, error) => {
		reply = () => Response.json(error ? { error } : {}, { status });
		const { handle } = await groupClient(cred, DID);

		const res = await handle(PATH, { method: 'GET' });

		expect(res.status).toBe(status);
		if (error) expect(((await res.json()) as { error: string }).error).toBe(error);
		expect(refreshes()).toHaveLength(0);
	});
});

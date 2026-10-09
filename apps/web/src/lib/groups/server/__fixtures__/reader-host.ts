// A fake group host behind the real space reader.
//
// A page test describes the host as a `GroupSpaceReader`-shaped object (what each
// space holds, which reads fail, a log of the reads), and this fixture answers the
// reader's XRPC calls from it: `space.getRecord`, `space.listRecords` and
// `simplespace.getSpace`. The credential lookup, the session and the transport
// stay real, so a test depends on the wire format and the linked-session seam,
// never on which module builds the reader.
//
// A test file opts in to the session seam as ./linked-group.ts describes, gives
// its platform env `OAUTH_SESSIONS: fixtureSessions`, and calls `serveReader` in
// each test. `serveReader(did, null)` leaves the group unlinked: no reader.
import { vi } from 'vitest';
import type { GroupSpaceReader } from '../about-read';
import { linkedServices } from './linked-oauth-stub';
import { STUB_PDS_SERVICE } from './linked-group';

import { GROUP_SESSION_PREFIX } from '../session';
/** Groups whose stored session cannot be restored (`breakSession`). */
const broken = new Set<string>();

/** The sessions namespace for every group a test linked, read live, with a count
 *  of the session lookups so a test can say how many readers a request made. */
export const fixtureSessions = {
	reads: 0,
	get: async (key: string) => {
		fixtureSessions.reads++;
		const did = key.startsWith(GROUP_SESSION_PREFIX) ? key.slice(GROUP_SESSION_PREFIX.length) : '';
		return linkedServices.has(did) || broken.has(did) ? '{}' : null;
	}
} as unknown as KVNamespace & { reads: number };

/** A group the store says is linked whose session then fails to restore, as an
 *  expired or revoked link would: building its reader throws. */
export function breakSession(groupDid: string): void {
	hosts.delete(groupDid);
	linkedServices.delete(groupDid);
	broken.add(groupDid);
}

const json = (status: number, body: unknown) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A host failure as the PDS reports it, from the error the fake threw: a status
 *  it names ("failed: 502") is the response's status, and `SpaceNotFound` keeps
 *  its code, since callers tell a missing space from other failures by it. The
 *  real transport then words the error as it would for a real host. */
function failure(e: unknown): Response {
	const message = e instanceof Error ? e.message : String(e);
	if (/\bSpaceNotFound\b/.test(message)) return json(400, { error: 'SpaceNotFound', message });
	const named = /failed: (\d{3})\b/.exec(message);
	return json(named ? Number(named[1]) : 500, { message });
}

async function answer(host: GroupSpaceReader, url: URL): Promise<Response> {
	const q = Object.fromEntries(url.searchParams);
	try {
		switch (url.pathname) {
			case '/xrpc/com.atproto.space.getRecord': {
				const record = await host.get({
					space: q.space,
					repo: q.repo,
					collection: q.collection,
					rkey: q.rkey
				});
				if (!record) return json(400, { error: 'RecordNotFound' });
				return json(200, { uri: record.uri, cid: record.cid, value: record.value });
			}
			case '/xrpc/com.atproto.space.listRecords': {
				const records = await host.list({
					space: q.space,
					repo: q.repo,
					...(q.collection ? { collection: q.collection } : {})
				});
				return json(200, {
					records: records.map((r) => ({
						collection: r.collection,
						rkey: r.rkey,
						cid: r.cid,
						value: r.value
					}))
				});
			}
			case '/xrpc/com.atproto.simplespace.getSpace': {
				const { readPolicy } = await host.getSpace(q.space);
				return json(200, { readPolicy: { $type: readPolicy } });
			}
		}
	} catch (e) {
		return failure(e);
	}
	throw new Error(`reader-host: no answer for ${url.pathname}`);
}

/** Each served group's host, by DID. A read names its group in `space`. */
const hosts = new Map<string, GroupSpaceReader>();

/** Links `groupDid` and answers its reads from `host`, or unlinks it when `host`
 *  is null. Each group keeps its own host until the test ends. Any request this
 *  fixture cannot answer fails the test. */
export function serveReader(groupDid: string, host: GroupSpaceReader | null): void {
	if (!host) {
		hosts.delete(groupDid);
		linkedServices.delete(groupDid);
		return;
	}
	hosts.set(groupDid, host);
	linkedServices.set(groupDid, STUB_PDS_SERVICE);
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: RequestInfo | URL) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin !== new URL(STUB_PDS_SERVICE).origin) {
				throw new Error(`reader-host: unexpected request to ${url.href}`);
			}
			const did = /^at:\/\/([^/]+)\//.exec(url.searchParams.get('space') ?? '')?.[1] ?? '';
			const served = hosts.get(did);
			if (!served) throw new Error(`reader-host: no host served for ${did || url.href}`);
			return answer(served, url);
		})
	);
}

/** For an `afterEach`: no host, link or session count outlives its test. */
export function resetReaderHost(): void {
	hosts.clear();
	broken.clear();
	linkedServices.clear();
	fixtureSessions.reads = 0;
}

// A fake group PDS: the one host that both the create and the settings save
// talk to.
//
// It stands in for `GROUP_PDS_SERVICE` behind a stubbed global `fetch`, so the
// code under test runs its real transports (the session, the provisioner, the
// writer, the reader) instead of injected seams that would only assert the
// test's own fixture. It records every XRPC call in order, so "did not happen"
// can be asserted rather than assumed.
//
// It keeps state wherever a flow reads back what it wrote:
//
//   space records   The write gate resolves from the members space, so a stub
//                   that could not read back what was just written would test a
//                   gate no deployment runs. A missing record is the PDS's 400,
//                   which the reader maps to "absent".
//   space config    `createSpace`, `getSpace` and `updateSpace` share one table,
//                   as they do on a real host. An `updateSpace` replaces only
//                   the fields it carries, so a test can see what it left alone.
//
// The PLC half echoes back the `recoveryKey` the mint sent, as the real
// directory does, so a mint that forgot to send one, or sent it second, still
// fails.
import { vi } from 'vitest';

export interface StubPdsOptions {
	/** The DID every session on this host authenticates as: the group's. */
	did: string;
	/** The handle the host registered, which a session reports. */
	handle: string;
	/** Replaces the `createAccount` response, which is where a name collision
	 *  lands. */
	account?: () => Response;
	/** Answers a call instead of the stub when it returns a Response: the way a
	 *  test fails one step. */
	fail?: (nsid: string, init?: RequestInit) => Response | undefined;
}

/** One XRPC call as the host saw it: the method without its query string, and
 *  the parsed JSON body of a procedure (`null` for a query). */
export interface StubPdsRequest {
	nsid: string;
	body: Record<string, unknown> | null;
}

/** A space's configuration, as `getSpace` reports it. */
export interface StubSpaceConfig {
	readPolicy: unknown;
	writePolicy: unknown;
	appAccess: unknown;
}

interface SpaceRecordWrite {
	space: string;
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
}

interface RepoRecordWrite {
	repo: string;
	collection: string;
	rkey: string;
	record: Record<string, unknown>;
}

/** The procedures that change something on the host. Everything else this
 *  stub answers is a read or a session. */
const WRITE_METHODS = new Set([
	'com.atproto.simplespace.createSpace',
	'com.atproto.simplespace.updateSpace',
	'com.atproto.simplespace.putMember',
	'com.atproto.simplespace.removeMember',
	'com.atproto.space.putRecord',
	'com.atproto.space.createRecord',
	'com.atproto.space.deleteRecord',
	'com.atproto.repo.putRecord',
	'com.atproto.repo.createRecord',
	'com.atproto.repo.deleteRecord'
]);

export function stubPds(options: StubPdsOptions) {
	const { did, handle } = options;
	/** Every call in order, as the raw tail of its URL (query included). */
	const calls: string[] = [];
	/** Every XRPC call in order, with its body. */
	const requests: StubPdsRequest[] = [];
	/** Every record written into a space, in order. */
	const spaceWrites: SpaceRecordWrite[] = [];
	/** Every record written into the group's public repo, in order. Kept apart
	 *  from `spaceWrites` because the container matters: a declaration written
	 *  into a space would be invisible to the anonymous readers it exists for. */
	const repoWrites: RepoRecordWrite[] = [];
	/** Space configuration by space URI. */
	const spaces = new Map<string, StubSpaceConfig>();
	/** What a space read sees: the latest write per record, minus deletes. */
	const liveRecords = new Map<string, SpaceRecordWrite>();
	const recordKey = (space: string | null, collection: string | null, rkey: string | null) =>
		`${space}|${collection}|${rkey}`;
	let recoveryKey: string | undefined;

	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = String(input);

		if (url.startsWith('https://plc.directory/')) {
			calls.push('plc.directory/data');
			return Response.json({ rotationKeys: [recoveryKey, 'did:key:zPdsOwnedKey'] });
		}

		const tail = url.split('/xrpc/')[1] ?? url;
		const nsid = tail.split('?')[0];
		calls.push(tail);
		const body =
			typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		requests.push({ nsid, body });

		const failed = options.fail?.(nsid, init);
		if (failed) return failed;

		const query = new URL(url).searchParams;
		switch (nsid) {
			case 'com.atproto.server.createAccount':
				({ recoveryKey } = (body ?? {}) as { recoveryKey?: string });
				return options.account?.() ?? Response.json({ did, handle, accessJwt: 'master-jwt' });

			case 'com.atproto.server.createAppPassword':
				return Response.json({ password: 'app-pass-1234' });

			case 'com.atproto.server.createSession':
				return Response.json({
					did,
					handle,
					accessJwt: 'group-jwt',
					refreshJwt: 'group-refresh'
				});

			case 'com.atproto.simplespace.createSpace': {
				const { type, skey, readPolicy, writePolicy, appAccess } = body as Record<string, string>;
				const uri = `at://${did}/space/${type}/${skey}`;
				if (spaces.has(uri)) {
					return Response.json(
						{ error: 'SpaceAlreadyExists', message: `${uri} already exists` },
						{ status: 400 }
					);
				}
				spaces.set(uri, { readPolicy, writePolicy, appAccess });
				return Response.json({ uri });
			}

			case 'com.atproto.simplespace.getSpace': {
				const uri = query.get('space') ?? '';
				const config = spaces.get(uri);
				if (!config) return Response.json({ error: 'SpaceNotFound' }, { status: 400 });
				return Response.json({ uri, ...config });
			}

			// Omitted fields are left unchanged, as the lexicon says. The procedure
			// has no output, so a success is an empty 200.
			case 'com.atproto.simplespace.updateSpace': {
				const { space, ...changes } = body as { space: string } & Partial<StubSpaceConfig>;
				const config = spaces.get(space);
				if (!config) return Response.json({ error: 'SpaceNotFound' }, { status: 400 });
				spaces.set(space, { ...config, ...changes });
				return new Response(null, { status: 200 });
			}

			case 'com.atproto.space.putRecord':
			case 'com.atproto.space.createRecord': {
				const write = body as unknown as SpaceRecordWrite;
				spaceWrites.push(write);
				liveRecords.set(recordKey(write.space, write.collection, write.rkey), write);
				return Response.json({
					uri: `${write.space}/${did}/${write.collection}/${write.rkey}`,
					cid: 'bafycreate'
				});
			}

			case 'com.atproto.space.deleteRecord': {
				const { space, collection, rkey } = body as Record<string, string>;
				liveRecords.delete(recordKey(space, collection, rkey));
				return Response.json({});
			}

			case 'com.atproto.space.getRecord': {
				const hit = liveRecords.get(
					recordKey(query.get('space'), query.get('collection'), query.get('rkey'))
				);
				if (!hit) return Response.json({ error: 'RecordNotFound' }, { status: 400 });
				return Response.json({
					uri: `${hit.space}/${did}/${hit.collection}/${hit.rkey}`,
					cid: 'bafycreate',
					value: hit.record
				});
			}

			case 'com.atproto.space.listRecords': {
				const collection = query.get('collection');
				const records = [...liveRecords.values()]
					.filter(
						(w) => w.space === query.get('space') && (!collection || w.collection === collection)
					)
					.map((w) => ({
						uri: `${w.space}/${did}/${w.collection}/${w.rkey}`,
						cid: 'bafycreate',
						value: w.record
					}));
				return Response.json({ records });
			}

			// The group's public repo, where the declaration lives.
			case 'com.atproto.repo.putRecord':
			case 'com.atproto.repo.createRecord': {
				const write = body as unknown as RepoRecordWrite;
				repoWrites.push(write);
				return Response.json({
					uri: `at://${write.repo}/${write.collection}/${write.rkey}`,
					cid: 'bafycreate'
				});
			}

			// Deleting a missing record is a no-op on the reference PDS, not an
			// error, so there is nothing to look up first.
			case 'com.atproto.repo.deleteRecord':
				return Response.json({});
		}
		throw new Error(`unexpected call to ${url}`);
	});

	return {
		calls,
		requests,
		spaceWrites,
		repoWrites,
		spaces,
		/** The calls that changed something on the host, in order. */
		writes: () => requests.filter((r) => WRITE_METHODS.has(r.nsid)),
		/** Forgets every call so far, so a test's assertions start after its
		 *  setup. State (spaces, records) is kept. */
		clearLog: () => {
			calls.length = 0;
			requests.length = 0;
			spaceWrites.length = 0;
			repoWrites.length = 0;
		}
	};
}

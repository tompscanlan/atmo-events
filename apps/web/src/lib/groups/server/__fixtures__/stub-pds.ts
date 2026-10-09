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
//   member lists    `putMember`, `removeMember` and `listMembers` share one
//                   list per space, which a test can seed and inspect. Each
//                   needs the space to exist, as on a real host.
//   repo records    The declaration lives in the group's public repo, and
//                   Repair reads it back (`getRecord`) to decide whether to
//                   write or withdraw it, so a second run can write nothing.
//   blobs           `uploadBlob` keeps each upload's type and bytes, and
//                   answers with a reference to it, as an event image needs.
//
// Both listings page the way the reference host does, so a caller that reads
// only the first page is caught:
//
//   listRecords   newest URI first, a cursor only when the page is full
//   listMembers   by DID ascending, a cursor whenever the page is not empty
//
// A test can shrink either page (`recordPageSize`, `memberPageSize`) to put a
// record or a member on page two without writing a hundred of them.
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
	 *  test fails one step. `query` is the call's query string, so a test can
	 *  fail one page of a listing. */
	fail?: (nsid: string, init?: RequestInit, query?: URLSearchParams) => Response | undefined;
	/** The most records one `listRecords` page returns, below what the caller
	 *  asked for. */
	recordPageSize?: number;
	/** The most members one `listMembers` page returns, below what the caller
	 *  asked for. */
	memberPageSize?: number;
}

/** One XRPC call as the host saw it: the method without its query string, the
 *  parsed JSON body of a procedure (`null` for a query), and the query
 *  parameters (empty for a procedure). */
export interface StubPdsRequest {
	nsid: string;
	body: Record<string, unknown> | null;
	params: Record<string, string>;
}

/** One entry on a space's member list, as `listMembers` reports it. */
export interface StubSpaceMember {
	did: string;
	read: boolean;
	write: boolean;
}

/** A space's configuration, as `getSpace` reports it. */
export interface StubSpaceConfig {
	readPolicy: unknown;
	writePolicy: unknown;
	appAccess: unknown;
}

/** A `putMember` body. */
type MemberPut = StubSpaceMember & { space: string };

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

/** One `uploadBlob` body, as the host received it. */
export interface StubBlob {
	mimeType: string;
	bytes: Uint8Array;
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
	'com.atproto.repo.deleteRecord',
	'com.atproto.repo.uploadBlob'
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
	/** The same for the group's public repo, keyed by repo, collection and rkey. */
	const liveRepoRecords = new Map<string, RepoRecordWrite>();
	/** Every blob uploaded, in order. */
	const blobs: StubBlob[] = [];
	/** Each space's member list, by space URI, then by member DID. */
	const memberLists = new Map<string, Map<string, StubSpaceMember>>();
	const memberList = (space: string) => {
		let list = memberLists.get(space);
		if (!list) memberLists.set(space, (list = new Map()));
		return list;
	};
	const pageSize = (asked: string | null, fallback: number, cap: number | undefined) =>
		Math.min(asked ? Number(asked) : fallback, cap ?? Infinity);
	const spaceNotFound = () => Response.json({ error: 'SpaceNotFound' }, { status: 400 });
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
		const query = new URL(url).searchParams;
		requests.push({ nsid, body, params: Object.fromEntries(query) });

		const failed = options.fail?.(nsid, init, query);
		if (failed) return failed;

		switch (nsid) {
			case 'com.atproto.server.createAccount':
				({ recoveryKey } = (body ?? {}) as { recoveryKey?: string });
				return options.account?.() ?? Response.json({ did, handle, accessJwt: 'master-jwt' });

			case 'com.atproto.simplespace.createSpace': {
				const { spaceType, skey, readPolicy, writePolicy, appAccess } = body as Record<
					string,
					string
				>;
				// The host takes the space's type as `spaceType` and refuses a body without
				// it, so a caller sending `type` fails here too.
				if (!spaceType) {
					return Response.json(
						{ error: 'InvalidRequest', message: 'Input must have the property "spaceType"' },
						{ status: 400 }
					);
				}
				const uri = `at://${did}/space/${spaceType}/${skey}`;
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

			// The reference host's paging: newest URI first, `uri < cursor` after
			// the first page, and a cursor only when the page came back full.
			case 'com.atproto.space.listRecords': {
				const collection = query.get('collection');
				const cursor = query.get('cursor');
				const limit = pageSize(query.get('limit'), 50, options.recordPageSize);
				const page = [...liveRecords.values()]
					.filter(
						(w) => w.space === query.get('space') && (!collection || w.collection === collection)
					)
					.map((w) => ({ uri: `${w.space}/${did}/${w.collection}/${w.rkey}`, write: w }))
					.sort((a, b) => (a.uri < b.uri ? 1 : a.uri > b.uri ? -1 : 0))
					.filter((r) => !cursor || r.uri < cursor)
					.slice(0, limit);
				return Response.json({
					cursor: page.length >= limit ? page.at(-1)?.uri : undefined,
					records: page.map(({ uri, write }) => ({
						uri,
						cid: 'bafycreate',
						value: write.record
					}))
				});
			}

			// A member list is the space owner's to change. Both procedures are
			// upserts and deletes with no output, so success is an empty 200.
			case 'com.atproto.simplespace.putMember': {
				const { space, did: member, read, write } = body as unknown as MemberPut;
				if (!spaces.has(space)) return spaceNotFound();
				memberList(space).set(member, { did: member, read, write });
				return new Response(null, { status: 200 });
			}

			case 'com.atproto.simplespace.removeMember': {
				const { space, did: member } = body as { space: string; did: string };
				if (!spaces.has(space)) return spaceNotFound();
				memberList(space).delete(member);
				return new Response(null, { status: 200 });
			}

			// The reference host's paging: DIDs ascending, `did > cursor` after the
			// first page, and the last DID as the cursor whenever the page has one.
			// So the page after the last is an empty one, not a missing cursor.
			case 'com.atproto.simplespace.listMembers': {
				const space = query.get('space') ?? '';
				if (!spaces.has(space)) return spaceNotFound();
				const cursor = query.get('cursor');
				const limit = pageSize(query.get('limit'), 100, options.memberPageSize);
				const members = [...memberList(space).values()]
					.sort((a, b) => (a.did < b.did ? -1 : a.did > b.did ? 1 : 0))
					.filter((m) => !cursor || m.did > cursor)
					.slice(0, limit);
				return Response.json({ cursor: members.at(-1)?.did, members });
			}

			// The group's public repo, where the declaration lives.
			case 'com.atproto.repo.putRecord':
			case 'com.atproto.repo.createRecord': {
				const write = body as unknown as RepoRecordWrite;
				repoWrites.push(write);
				liveRepoRecords.set(recordKey(write.repo, write.collection, write.rkey), write);
				return Response.json({
					uri: `at://${write.repo}/${write.collection}/${write.rkey}`,
					cid: 'bafycreate'
				});
			}

			// Deleting a missing record is a no-op on the reference PDS, not an
			// error, so there is nothing to look up first.
			case 'com.atproto.repo.deleteRecord': {
				const { repo, collection, rkey } = body as Record<string, string>;
				liveRepoRecords.delete(recordKey(repo, collection, rkey));
				return Response.json({});
			}

			case 'com.atproto.repo.getRecord': {
				const hit = liveRepoRecords.get(
					recordKey(query.get('repo'), query.get('collection'), query.get('rkey'))
				);
				if (!hit) return Response.json({ error: 'RecordNotFound' }, { status: 400 });
				return Response.json({
					uri: `at://${hit.repo}/${hit.collection}/${hit.rkey}`,
					cid: 'bafycreate',
					value: hit.record
				});
			}

			// The body is the blob itself, typed by its content-type header.
			case 'com.atproto.repo.uploadBlob': {
				const mimeType = new Headers(init?.headers).get('content-type') ?? '';
				const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
				blobs.push({ mimeType, bytes });
				return Response.json({
					blob: {
						$type: 'blob',
						ref: { $link: `bafkreiupload${blobs.length}` },
						mimeType,
						size: bytes.byteLength
					}
				});
			}
		}
		throw new Error(`unexpected call to ${url}`);
	});

	return {
		calls,
		requests,
		spaceWrites,
		repoWrites,
		spaces,
		blobs,
		/** The DIDs on a space's member list, sorted. A test seeds a list through
		 *  the real transport, so the seed goes through the same checks. */
		listed: (space: string) => [...memberList(space).keys()].sort(),
		/** A space's member list with each entry's access, sorted by DID. */
		members: (space: string) =>
			[...memberList(space).values()].sort((a, b) => (a.did < b.did ? -1 : 1)),
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

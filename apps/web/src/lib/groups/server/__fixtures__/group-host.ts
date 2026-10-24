// A fake group host: the one host the settings save, the event writer and the
// refresh talk to.
//
// It answers behind a stubbed global `fetch`, so the code under test runs its
// real transports (the session, the writer, the reader) instead of injected
// seams that would only assert the test's own fixture. It records every XRPC
// call in order, so "did not happen" can be asserted rather than assumed.
//
// It keeps what a host keeps, and only that:
//
//   spaces          Which of the group's spaces exist. Every one answers
//                   `getSpace` with the managing app's policy: the host decides
//                   each read from the space's `access` record, so there is no
//                   read policy or member list to set, and a call that tries is
//                   one this fake does not answer.
//   space records   The write gate resolves from the members space, so a fake
//                   that could not read back what was just written would test a
//                   gate no deployment runs. A missing record is the host's 400,
//                   which the reader maps to "absent".
//   repo records    The declaration lives in the group's public repo, and the
//                   save reads it back (`getRecord`) to decide whether to write
//                   or withdraw it.
//   blobs           `uploadBlob` keeps each upload's type and bytes, and
//                   answers with a reference to it, as an event image needs.
//
// `listRecords` pages the way the reference host does, newest URI first with a
// cursor only when the page is full, so a caller that reads only the first page
// is caught. A test can shrink the page (`recordPageSize`) to put a record on
// page two without writing a hundred of them.
import { vi } from 'vitest';
import { fixtureKem } from './space-mac-host';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	GROUP_MEMBERSHIP_COLLECTION,
	MEMBERS_SPACE_READER_ROLES,
	accessGrantsRead,
	groupAccessRecord,
	parseGroupAccess
} from '../../members-record';
import {
	ABOUT_SPACE_TYPE,
	CALENDAR_SPACE_TYPE,
	MEMBERS_SPACE_TYPE,
	type GroupVisibility
} from '../../types';
import { POLICY_MANAGING_APP, groupSpaceUris, type GroupSpaceUris } from '../../ids';
import { SESSION_PERSON_HEADER } from './linked-oauth-stub';

export interface FakeGroupHostOptions {
	/** The DID every session on this host authenticates as: the group's. */
	did: string;
	/** Answers a call instead of the host when it returns a Response: the way a
	 *  test fails one step. `query` is the call's query string, so a test can
	 *  fail one page of a listing. */
	fail?: (nsid: string, init?: RequestInit, query?: URLSearchParams) => Response | undefined;
	/** The most records one `listRecords` page returns, below what the caller
	 *  asked for. */
	recordPageSize?: number;
}

/** One XRPC call as the host saw it: the method without its query string, the
 *  parsed JSON body of a procedure (`null` for a query), and the query
 *  parameters (empty for a procedure). */
export interface FakeGroupHostRequest {
	nsid: string;
	body: Record<string, unknown> | null;
	params: Record<string, string>;
	/** The bearer token the request carried, or null. */
	token: string | null;
	/** Whose fixture group session sent it (./linked-oauth-stub.ts), or null. */
	person: string | null;
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

/** One `uploadBlob` body, as the host received it. */
export interface FakeGroupHostBlob {
	mimeType: string;
	bytes: Uint8Array;
}

/** The procedures that change something on the host. Everything else this
 *  fake answers is a read. */
const WRITE_METHODS = new Set([
	'com.atproto.space.putRecord',
	'com.atproto.space.createRecord',
	'com.atproto.space.deleteRecord',
	'com.atproto.repo.putRecord',
	'com.atproto.repo.createRecord',
	'com.atproto.repo.deleteRecord',
	'com.atproto.repo.uploadBlob'
]);

export function fakeGroupHost(options: FakeGroupHostOptions) {
	const { did } = options;
	/** Every call in order, as the raw tail of its URL (query included). */
	const calls: string[] = [];
	/** Every XRPC call in order, with its body. */
	const requests: FakeGroupHostRequest[] = [];
	/** Every record written into a space, in order. */
	const spaceWrites: SpaceRecordWrite[] = [];
	/** Every record written into the group's public repo, in order. Kept apart
	 *  from `spaceWrites` because the container matters: a declaration written
	 *  into a space would be invisible to the anonymous readers it exists for. */
	const repoWrites: RepoRecordWrite[] = [];
	/** The group's spaces, by URI. */
	const spaces = new Set<string>();
	/** What a space read sees: the latest write per record, minus deletes. */
	const liveRecords = new Map<string, SpaceRecordWrite>();
	/** The same for the group's public repo, keyed by repo, collection and rkey. */
	const liveRepoRecords = new Map<string, RepoRecordWrite>();
	/** Every blob uploaded, in order. */
	const blobs: FakeGroupHostBlob[] = [];
	const recordKey = (space: string | null, collection: string | null, rkey: string | null) =>
		`${space}|${collection}|${rkey}`;
	const record = (space: string, collection: string, rkey: string) =>
		liveRecords.get(recordKey(space, collection, rkey))?.record;

	const serve = async (input: URL | string, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		const tail = url.split('/xrpc/')[1] ?? url;
		const nsid = tail.split('?')[0];
		calls.push(tail);
		const body =
			typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
		const query = new URL(url).searchParams;
		const headers = new Headers(init?.headers);
		const token = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
		const person = headers.get(SESSION_PERSON_HEADER);
		requests.push({ nsid, body, params: Object.fromEntries(query), token, person });

		const failed = options.fail?.(nsid, init, query);
		if (failed) return failed;

		switch (nsid) {
			case 'com.atproto.simplespace.getSpace': {
				const uri = query.get('space') ?? '';
				if (!spaces.has(uri)) return Response.json({ error: 'SpaceNotFound' }, { status: 400 });
				return Response.json({ uri, readPolicy: { $type: POLICY_MANAGING_APP } });
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
				const found = {
					uri: `${hit.space}/${did}/${hit.collection}/${hit.rkey}`,
					cid: 'bafycreate'
				};
				// A read made with a credential asks for the record's MAC; one through the
				// group's session does not, and gets none.
				return Response.json(
					{ ...found, value: hit.record },
					{ headers: await (await fixtureKem).macHeaders(headers, found) }
				);
			}

			// The reference host's paging: newest URI first, `uri < cursor` after
			// the first page, and a cursor only when the page came back full.
			case 'com.atproto.space.listRecords': {
				const collection = query.get('collection');
				const cursor = query.get('cursor');
				const asked = query.get('limit');
				const limit = Math.min(asked ? Number(asked) : 50, options.recordPageSize ?? Infinity);
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
	};

	vi.stubGlobal('fetch', serve);

	return {
		calls,
		requests,
		spaceWrites,
		repoWrites,
		spaces,
		blobs,
		/** The record a space read would find at an address, or undefined. */
		record,
		/** Every record a space read would find in a space's collection. */
		records: (space: string, collection: string) =>
			[...liveRecords.values()]
				.filter((w) => w.space === space && w.collection === collection)
				.map((w) => w.record),
		/** Whether the host lets `holder` into `space`, as it decides a credential:
		 *  the group itself, anyone while the space's `access` says public, and a
		 *  member whose membership names a role that record grants a read. */
		admits: (holder: string, space: string): boolean => {
			if (holder === did) return true;
			const access = parseGroupAccess(record(space, GROUP_ACCESS_COLLECTION, GROUP_ACCESS_RKEY));
			if (access?.public === true) return true;
			const membership = record(
				groupSpaceUris(did).membersSpaceUri,
				GROUP_MEMBERSHIP_COLLECTION,
				holder
			);
			const roles = Array.isArray(membership?.roles)
				? membership.roles.filter((r): r is string => typeof r === 'string')
				: [];
			return accessGrantsRead(access, roles);
		},
		/** The group as the host holds it once made: its three spaces, each with
		 *  the `access` record it is made with. The about space's says
		 *  `visibility`; the other two are never public. Nothing goes through the
		 *  transport, so the log holds none of it. */
		holdGroup: (visibility: GroupVisibility): GroupSpaceUris => {
			const uris = groupSpaceUris(did);
			for (const [space, spaceType] of [
				[uris.aboutSpaceUri, ABOUT_SPACE_TYPE],
				[uris.membersSpaceUri, MEMBERS_SPACE_TYPE],
				[uris.calendarSpaceUri, CALENDAR_SPACE_TYPE]
			]) {
				spaces.add(space);
				const about = spaceType === ABOUT_SPACE_TYPE;
				const write = {
					space,
					collection: GROUP_ACCESS_COLLECTION,
					rkey: GROUP_ACCESS_RKEY,
					record: {
						...groupAccessRecord({
							spaceType,
							roles: about ? ABOUT_SPACE_READER_ROLES : MEMBERS_SPACE_READER_ROLES,
							public: about && visibility === 'public'
						}),
						$type: GROUP_ACCESS_COLLECTION
					}
				};
				liveRecords.set(recordKey(write.space, write.collection, write.rkey), write);
			}
			return uris;
		},
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

export type FakeGroupHost = ReturnType<typeof fakeGroupHost>;

// An in-memory group host behind the `GroupSpaceReader` interface, and a writer
// that writes into it.
//
// The reader stands in for the host's space reads: `getRecord`, `listRecords`
// and `getSpace`. A record lives at its space, repo, collection and rkey, and a
// read finds it only at that address, so a read of the wrong space or repo comes
// back empty, as it would from a real host. Every call is logged before it is
// answered, so "made no read" is asserted from the log rather than inferred
// from an empty result. The writer stands in for the group's PDS writes, so a
// gate that reads back what a test wrote reads it from the same host.
//
// The wire is not faked here: a test that depends on the transport serves this
// reader through ./reader-host.ts, which keeps the session and the real reader
// in front of it.
import type { GroupSpaceReader, GroupSpaceRecord } from '../about-read';
import type { GroupRepoWrite, GroupRepoWriter } from '../group-write';

/** A record to hold. `space` defaults to the reader's own, `repo` to the
 *  group's, and `cid` to `bafytest`. */
export interface SpaceRecordInput {
	space?: string;
	repo?: string;
	collection: string;
	rkey: string;
	value: Record<string, unknown>;
	cid?: string;
}

/** One call, as the reader received it. */
export type SpaceReadCall =
	| { method: 'get'; space: string; repo: string; collection: string; rkey: string }
	| { method: 'list'; space: string; repo: string; collection?: string }
	| { method: 'getSpace'; space: string };

export interface SpaceReaderOptions {
	/** The space a record without one lives in. */
	space?: string;
	records?: SpaceRecordInput[];
	/** What `getSpace` answers for each space: a read policy, or the error the
	 *  read fails with. A space not named here has no configuration to give, so
	 *  asking for it throws. */
	policies?: Record<string, string | Error>;
	/** A host that ignores the collection filter: a listing returns every record
	 *  in the space, whatever collection was asked for. */
	ignoresFilter?: boolean;
	/** Fails a call: an error returned here is thrown in place of the answer,
	 *  after the call is logged. */
	fail?: (call: SpaceReadCall) => Error | undefined;
	/** Hears each call's log line as it is made, for a test that puts this
	 *  host's calls in one sequence with another party's requests. */
	onCall?: (line: string) => void;
}

export interface FakeSpaceReader extends GroupSpaceReader {
	/** Every call in order, as `get <space> <repo> <collection> <rkey>`,
	 *  `list <space> <repo> <collection>` or `getSpace <space>`. */
	calls: string[];
	/** The logged calls that name `space`. */
	callsIn(space: string): string[];
	/** Holds `record`, replacing whatever was at its address. */
	put(record: SpaceRecordInput): void;
	/** Drops the record at an address, if there is one. */
	remove(address: { space: string; repo?: string; collection: string; rkey: string }): void;
}

const NSID = {
	get: 'com.atproto.space.getRecord',
	list: 'com.atproto.space.listRecords',
	getSpace: 'com.atproto.simplespace.getSpace'
} as const;

/** A `fail` for a host that is down: every call, or every call that names
 *  `space`, fails the way the real reader words it, as
 *  "com.atproto.space.getRecord failed: 502". */
export function hostDown(
	answer: number | string = 502,
	space?: string
): (call: SpaceReadCall) => Error | undefined {
	return (call) =>
		!space || call.space === space
			? new Error(`${NSID[call.method]} failed: ${answer}`)
			: undefined;
}

function describeCall(call: SpaceReadCall): string {
	switch (call.method) {
		case 'get':
			return `get ${call.space} ${call.repo} ${call.collection} ${call.rkey}`;
		case 'list':
			return `list ${call.space} ${call.repo} ${call.collection ?? '(no collection)'}`;
		case 'getSpace':
			return `getSpace ${call.space}`;
	}
}

/** A reader over the records the group `repo` holds in its spaces. */
export function spaceReader(repo: string, options: SpaceReaderOptions = {}): FakeSpaceReader {
	const held = new Map<string, GroupSpaceRecord & { space: string; repo: string }>();
	const key = (space: string, owner: string, collection: string, rkey: string) =>
		`${space}|${owner}|${collection}|${rkey}`;

	const calls: string[] = [];
	const answer = (call: SpaceReadCall) => {
		const line = describeCall(call);
		calls.push(line);
		options.onCall?.(line);
		const failure = options.fail?.(call);
		if (failure) throw failure;
	};

	const reader: FakeSpaceReader = {
		calls,
		callsIn: (space) => calls.filter((call) => call.split(' ')[1] === space),
		put(record) {
			const space = record.space ?? options.space;
			if (!space) {
				throw new Error(`space-reader: ${record.collection}/${record.rkey} names no space`);
			}
			const owner = record.repo ?? repo;
			held.set(key(space, owner, record.collection, record.rkey), {
				space,
				repo: owner,
				uri: `${space}/${owner}/${record.collection}/${record.rkey}`,
				cid: record.cid ?? 'bafytest',
				collection: record.collection,
				rkey: record.rkey,
				value: record.value
			});
		},
		remove(address) {
			held.delete(key(address.space, address.repo ?? repo, address.collection, address.rkey));
		},
		async get(q) {
			answer({ method: 'get', ...q });
			const found = held.get(key(q.space, q.repo, q.collection, q.rkey));
			return found ? recordOf(found) : null;
		},
		async list(q) {
			answer({ method: 'list', ...q });
			return [...held.values()]
				.filter(
					(r) =>
						r.space === q.space &&
						r.repo === q.repo &&
						(options.ignoresFilter || !q.collection || r.collection === q.collection)
				)
				.map(recordOf);
		},
		async getSpace(space) {
			answer({ method: 'getSpace', space });
			const policy = options.policies?.[space];
			if (policy instanceof Error) throw policy;
			if (policy === undefined) {
				throw new Error(`space-reader: this host holds no configuration for ${space}`);
			}
			return { readPolicy: policy };
		}
	};
	for (const record of options.records ?? []) reader.put(record);
	return reader;
}

function recordOf(held: GroupSpaceRecord): GroupSpaceRecord {
	const { uri, cid, collection, rkey, value } = held;
	return { uri, cid, collection, rkey, value };
}

export interface RecordingWriter extends GroupRepoWriter {
	/** Every write in order, deletes included. */
	writes: GroupRepoWrite[];
}

/** A writer that records each write and, given `host`, applies a space write to
 *  it, so the gate and any later read see what the test wrote: the latest write
 *  at an address wins, and a delete removes it. A write to the public repo is
 *  only recorded, since no space reader can see it. */
export function recordingWriter(host?: FakeSpaceReader): RecordingWriter {
	const writes: GroupRepoWrite[] = [];
	const writer: GroupRepoWriter = async (write) => {
		writes.push(write);
		if (host && write.space) {
			const address = {
				space: write.space,
				repo: write.repo,
				collection: write.collection,
				rkey: write.rkey
			};
			if (write.intent === 'delete') host.remove(address);
			else host.put({ ...address, value: write.record });
		}
		return {
			uri: write.space
				? `${write.space}/${write.repo}/${write.collection}/${write.rkey}`
				: `at://${write.repo}/${write.collection}/${write.rkey}`,
			cid: 'bafytest'
		};
	};
	return Object.assign(writer, { writes });
}

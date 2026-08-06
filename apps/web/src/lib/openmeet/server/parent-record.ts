// Fetching an RSVP's parent event from its author's PDS, on demand.
//
// WHY THIS IS HTTP AND NOT A DATABASE READ. The obvious source for a missing
// parent is atmo's own D1 `records_event` table — the sink runs in a Worker that
// has the binding. It cannot reach it: the contrail Sink seam hands `onRecords`
// a `{ phase }` context and nothing else, and `createOpenMeetSink` takes a
// backend resolver and a fetch. Plumbing a D1 binding down here would also spend
// the property this directory was built for — the transform layer imports
// nothing from atmo or contrail, so lifting it into an out-of-process consumer
// is a move rather than a rewrite, and this sink has a defined end of life.
//
// Re-fetching from the author's PDS costs two extra requests through the fetch
// the sink already holds, needs no binding, and is AUTHORITATIVE rather than a
// read of our own index. It is also the only mechanism that repairs the class of
// drop that waiting never fixes: a parent event old enough that no backfill has
// ever fed it (record_time months back), which is absent from prod and will stay
// absent until something asks for it by name. An RSVP arriving against one is
// exactly that ask.
//
// Deliberately dependency-free, like ./types and the transform pair: the only
// import is the record shape those files already declare structurally.
import type { SinkRecordEvent } from './types';

/** DID PLC directory. The `did:plc:` method's resolver — an ordinary HTTPS
 *  lookup returning a DID document. */
const PLC_DIRECTORY = 'https://plc.directory';

/** Ceiling on a single lookup. A cron-driven Worker invocation must stay
 *  bounded, and a repair is a best-effort side path: a PDS that does not answer
 *  promptly costs the RSVP, not the batch. */
const LOOKUP_TIMEOUT_MS = 5_000;

/** Why a parent could not be produced. A CLOSED SET — these values reach log
 *  lines, so nothing derived from a response body may join them. */
export type ParentUnavailableReason =
	/** The RSVP's subject was not a well-formed at:// record URI. */
	| 'bad-uri'
	/** Neither did:plc nor did:web; nothing here knows how to resolve it. */
	| 'unsupported-did-method'
	/** The DID document did not resolve, or advertised no https PDS endpoint. */
	| 'did-unresolved'
	/** The PDS answered, and the record is not there. The parent is genuinely
	 *  gone — deleted, or never existed. Nothing further will fix this RSVP. */
	| 'record-absent'
	/** The PDS could not be reached or gave an unusable answer. Unlike
	 *  `record-absent` this one may well succeed later. */
	| 'fetch-failed';

export type ParentLookup =
	| { kind: 'record'; event: SinkRecordEvent }
	| { kind: 'unavailable'; reason: ParentUnavailableReason };

const unavailable = (reason: ParentUnavailableReason): ParentLookup => ({
	kind: 'unavailable',
	reason
});

/** Split an at:// record URI into its three parts, or null if it is not one.
 *
 *  The sink's RSVP transform has already validated the subject this far
 *  (`rsvp-transform.ts` rejects a non-at:// or short URI before the record is
 *  ever offered to OpenMeet), so `bad-uri` is a belt-and-braces outcome rather
 *  than an expected one — but this module is also the thing that would be
 *  reused by an out-of-process consumer, so it validates its own input. */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
	if (!uri.startsWith('at://')) return null;
	const parts = uri.slice('at://'.length).split('/');
	if (parts.length !== 3) return null;
	const [did, collection, rkey] = parts;
	// The DID goes into a URL PATH unescaped (plc.directory serves `/did:plc:…`
	// and percent-encoding the colons 404s), so it is checked against the DID
	// grammar's charset here rather than escaped there — which is also what keeps
	// a `?` or `#` in a subject URI from rewriting the lookup it lands in.
	if (!/^did:[a-z0-9]+:[a-zA-Z0-9._%:-]+$/.test(did)) return null;
	if (!collection || !rkey) return null;
	return { did, collection, rkey };
}

/** GET a JSON document, resolving to null on any transport-level failure.
 *
 *  `fetchFn` is called as a bare function rather than a method: on workerd the
 *  global fetch throws "Illegal invocation" when `this` is bound to a non-global
 *  object, which is the same trap `OpenMeetIntakeClient` documents. */
async function getJson(
	url: string,
	fetchFn: typeof fetch
): Promise<{ status: number; body: unknown } | null> {
	let res: Response;
	try {
		res = await fetchFn(url, {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS)
		});
	} catch {
		return null;
	}
	if (!res.ok) return { status: res.status, body: null };
	try {
		return { status: res.status, body: await res.json() };
	} catch {
		return null;
	}
}

/** Build the URL of a DID's document. Returns null for methods this does not
 *  implement, which for the OpenMeet corpus is everything but plc and web. */
function didDocumentUrl(did: string): string | null {
	if (did.startsWith('did:plc:')) return `${PLC_DIRECTORY}/${did}`;
	if (did.startsWith('did:web:')) {
		// did:web encodes the path as colon-separated segments, with the
		// well-known form when there are none.
		const segments = did.slice('did:web:'.length).split(':').map(decodeURIComponent);
		const host = segments[0];
		// A decoded segment can reintroduce a path separator; a host that carries
		// one is not a host.
		if (!host || segments.some((s) => s.includes('/'))) return null;
		const path = segments.slice(1);
		return path.length > 0
			? `https://${host}/${path.join('/')}/did.json`
			: `https://${host}/.well-known/did.json`;
	}
	return null;
}

/** Resolve a DID to its PDS endpoint.
 *
 *  Only an `https://` endpoint is accepted. The endpoint is a value from a
 *  document the record's author controls, and the next thing that happens to it
 *  is a fetch from inside the Worker — so a plaintext or otherwise odd scheme is
 *  treated as no endpoint at all rather than followed. The sink only runs
 *  against production (it is inert without `OPENMEET_SINK_URL`), where every
 *  real PDS is https. */
async function resolvePds(
	did: string,
	fetchFn: typeof fetch
): Promise<string | ParentUnavailableReason> {
	const docUrl = didDocumentUrl(did);
	if (!docUrl) return 'unsupported-did-method';

	const doc = await getJson(docUrl, fetchFn);
	if (!doc || doc.body === null) return 'did-unresolved';

	const service = (doc.body as { service?: unknown }).service;
	if (!Array.isArray(service)) return 'did-unresolved';

	for (const entry of service as Array<Record<string, unknown>>) {
		const id = typeof entry?.id === 'string' ? entry.id : '';
		// The id is either the relative `#atproto_pds` or the DID-qualified form.
		if (id !== '#atproto_pds' && id !== `${did}#atproto_pds`) continue;
		const endpoint = entry.serviceEndpoint;
		if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return 'did-unresolved';
		return endpoint.replace(/\/+$/, '');
	}
	return 'did-unresolved';
}

/** When the fetched record carries no usable timestamp.
 *
 *  `time_us` exists on contrail's RecordEvent as the commit's wall clock; a
 *  record read back through `getRecord` has no commit to read it from. The event
 *  transform only carries it into `source.metadata`, so the fallback affects
 *  provenance rather than correctness — but preferring the record's own
 *  `createdAt` keeps the fed metadata about the RECORD rather than about when we
 *  happened to repair it. */
function timeUsFor(record: Record<string, unknown>): number {
	const createdAt = record.createdAt;
	if (typeof createdAt === 'string') {
		const ms = Date.parse(createdAt);
		if (!Number.isNaN(ms)) return ms * 1000;
	}
	return Date.now() * 1000;
}

/** Fetch one record from its author's PDS and shape it as the sink's transforms
 *  expect, so a repaired parent goes through `eventRequestFor` verbatim rather
 *  than through a second bespoke mapping of the same lexicon. */
export async function fetchParentRecord(uri: string, fetchFn: typeof fetch): Promise<ParentLookup> {
	const parsed = parseAtUri(uri);
	if (!parsed) return unavailable('bad-uri');
	const { did, collection, rkey } = parsed;

	const pds = await resolvePds(did, fetchFn);
	if (!pds.startsWith('https://')) return unavailable(pds as ParentUnavailableReason);

	const query = new URLSearchParams({ repo: did, collection, rkey });
	const got = await getJson(`${pds}/xrpc/com.atproto.repo.getRecord?${query}`, fetchFn);
	if (!got) return unavailable('fetch-failed');
	// `com.atproto.repo.getRecord` reports RecordNotFound as a 400, not a 404,
	// so both statuses mean the same thing here: the repo answered and the
	// record is not in it.
	if (got.status === 400 || got.status === 404) return unavailable('record-absent');
	if (got.body === null) return unavailable('fetch-failed');

	const body = got.body as { cid?: unknown; value?: unknown };
	const value = body.value;
	if (!value || typeof value !== 'object') return unavailable('record-absent');
	const record = value as Record<string, unknown>;

	return {
		kind: 'record',
		event: {
			kind: 'created',
			uri: `at://${did}/${collection}/${rkey}`,
			did,
			collection,
			rkey,
			cid: typeof body.cid === 'string' ? body.cid : null,
			record,
			time_us: timeUsFor(record)
		}
	};
}

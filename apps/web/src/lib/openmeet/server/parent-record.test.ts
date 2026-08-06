import { describe, it, expect, vi } from 'vitest';
import { fetchParentRecord, parseAtUri } from './parent-record';

const DID = 'did:plc:alice';
const COLLECTION = 'community.lexicon.calendar.event';
const RKEY = '3mh4xhgmouk2e';
const URI = `at://${DID}/${COLLECTION}/${RKEY}`;

const PDS = 'https://pds.example';
const DID_DOC = {
	id: DID,
	service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: PDS }]
};
const RECORD = { name: 'Rescued Event', startsAt: '2026-03-20T18:00:00Z' };

/** A fetch double routing on URL, recording every call it was given. */
function router(routes: Array<[RegExp, () => Response]>) {
	const urls: string[] = [];
	const fn = vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		urls.push(url);
		for (const [pattern, respond] of routes) if (pattern.test(url)) return respond();
		return new Response(null, { status: 404 });
	});
	return { fn: fn as unknown as typeof fetch, urls };
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const workingNetwork = () =>
	router([
		[/plc\.directory/, () => json(DID_DOC)],
		[/getRecord/, () => json({ uri: URI, cid: 'bafyparent', value: RECORD })]
	]);

describe('parseAtUri', () => {
	it('splits a record uri into repo, collection and rkey', () => {
		expect(parseAtUri(URI)).toEqual({ did: DID, collection: COLLECTION, rkey: RKEY });
	});

	it('rejects anything that is not a three-part at:// record uri', () => {
		expect(parseAtUri('https://example.com/x')).toBeNull();
		expect(parseAtUri(`at://${DID}`)).toBeNull();
		expect(parseAtUri(`at://${DID}/${COLLECTION}`)).toBeNull();
		expect(parseAtUri(`at://${DID}/${COLLECTION}/${RKEY}/extra`)).toBeNull();
		expect(parseAtUri(`at://not-a-did/${COLLECTION}/${RKEY}`)).toBeNull();
	});
});

describe('fetchParentRecord', () => {
	it('resolves the did, reads the record, and shapes it for the transforms', async () => {
		const { fn, urls } = workingNetwork();
		const lookup = await fetchParentRecord(URI, fn);

		expect(urls[0]).toBe(`https://plc.directory/${DID}`);
		expect(urls[1]).toBe(
			`${PDS}/xrpc/com.atproto.repo.getRecord?repo=${encodeURIComponent(DID)}&collection=${COLLECTION}&rkey=${RKEY}`
		);
		expect(lookup).toEqual({
			kind: 'record',
			event: {
				kind: 'created',
				uri: URI,
				did: DID,
				collection: COLLECTION,
				rkey: RKEY,
				cid: 'bafyparent',
				record: RECORD,
				time_us: expect.any(Number)
			}
		});
	});

	it('resolves a did:web through its well-known document', async () => {
		const webDid = 'did:web:events.example';
		// getRecord first: the did is echoed in its `repo` query param, so a route
		// keyed on the host would swallow it.
		const { fn, urls } = router([
			[/getRecord/, () => json({ cid: 'c', value: RECORD })],
			[/events\.example/, () => json({ ...DID_DOC, id: webDid })]
		]);
		const lookup = await fetchParentRecord(`at://${webDid}/${COLLECTION}/${RKEY}`, fn);

		expect(urls[0]).toBe('https://events.example/.well-known/did.json');
		expect(lookup.kind).toBe('record');
	});

	// getRecord reports RecordNotFound as a 400, not a 404 — the one status a
	// naive implementation would read as "the request was wrong" rather than
	// "the record is gone".
	it.each([400, 404])('reports a %i from getRecord as the parent being absent', async (status) => {
		const { fn } = router([
			[/plc\.directory/, () => json(DID_DOC)],
			[/getRecord/, () => json({ error: 'RecordNotFound' }, status)]
		]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'record-absent'
		});
	});

	it('separates an unreachable pds from an absent record', async () => {
		const { fn } = router([
			[/plc\.directory/, () => json(DID_DOC)],
			[
				/getRecord/,
				() => {
					throw new Error('connection reset');
				}
			]
		]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'fetch-failed'
		});
	});

	it('gives up when the did does not resolve', async () => {
		const { fn } = router([[/plc\.directory/, () => new Response(null, { status: 404 })]]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'did-unresolved'
		});
	});

	it('gives up when the did document advertises no pds', async () => {
		const { fn } = router([[/plc\.directory/, () => json({ id: DID, service: [] })]]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'did-unresolved'
		});
	});

	// The endpoint is a value the record's author controls and the next thing
	// that happens to it is a fetch from inside the Worker, so a non-https scheme
	// is treated as no endpoint at all rather than followed.
	it('refuses to follow a non-https service endpoint', async () => {
		const { fn, urls } = router([
			[
				/plc\.directory/,
				() =>
					json({
						id: DID,
						service: [{ id: '#atproto_pds', serviceEndpoint: 'http://pds.example' }]
					})
			]
		]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'did-unresolved'
		});
		expect(urls).toHaveLength(1);
	});

	it('does not attempt a did method it cannot resolve', async () => {
		const { fn, urls } = router([]);
		expect(await fetchParentRecord(`at://did:key:zabc/${COLLECTION}/${RKEY}`, fn)).toEqual({
			kind: 'unavailable',
			reason: 'unsupported-did-method'
		});
		expect(urls).toHaveLength(0);
	});

	it('rejects a malformed uri without touching the network', async () => {
		const { fn, urls } = router([]);
		expect(await fetchParentRecord('https://example.com/event/1', fn)).toEqual({
			kind: 'unavailable',
			reason: 'bad-uri'
		});
		expect(urls).toHaveLength(0);
	});

	it('treats a bodyless getRecord answer as an absent record', async () => {
		const { fn } = router([
			[/plc\.directory/, () => json(DID_DOC)],
			[/getRecord/, () => json({ uri: URI, cid: 'c' })]
		]);
		expect(await fetchParentRecord(URI, fn)).toEqual({
			kind: 'unavailable',
			reason: 'record-absent'
		});
	});

	// `time_us` is contrail's commit clock and a record read back through
	// getRecord has no commit; preferring the record's own createdAt keeps the
	// metadata the sink feeds about the RECORD rather than about the repair.
	it('derives time_us from the record createdAt when it has one', async () => {
		const { fn } = router([
			[/plc\.directory/, () => json(DID_DOC)],
			[
				/getRecord/,
				() => json({ cid: 'c', value: { ...RECORD, createdAt: '2026-03-15T00:00:00.000Z' } })
			]
		]);
		expect(await fetchParentRecord(URI, fn)).toMatchObject({
			kind: 'record',
			event: { time_us: Date.parse('2026-03-15T00:00:00.000Z') * 1000 }
		});
	});
});

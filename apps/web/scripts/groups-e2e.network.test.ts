import { describe, expect, it, vi } from 'vitest';
import {
	createLedger,
	fixtureCheck,
	guardFetch,
	isLocal,
	isLoopback,
	localNames,
	outboundHandler,
	settingRefusals
} from './groups-e2e.network.mjs';

/** A ledger whose REFUSED lines land in an array instead of the console. */
function quietLedger() {
	const lines: string[] = [];
	return { ledger: createLedger((line: string) => lines.push(line)), lines };
}

/** A stand-in resolver, so no test sends a DNS query: each name's addresses, or
 *  ENOTFOUND for a name it lacks. */
function resolver(addressesByName: Record<string, string[]>) {
	return vi.fn(async (name: string, options: { all: true }) => {
		void options;
		const addresses = addressesByName[name];
		if (!addresses) {
			throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' });
		}
		return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
	});
}

describe('isLoopback', () => {
	it.each([
		'https://plc.directory/did:plc:abc',
		'https://slingshot.microcosm.blue/xrpc/com.bad-example.identity.resolveMiniDoc',
		'wss://jetstream1.us-east.bsky.network/subscribe',
		'http://regular.devnet.test'
	])('refuses %s, which is not this machine', (url) => {
		expect(isLoopback(url)).toBe(false);
	});

	it.each(['http://localhost:3010', 'http://127.0.0.1:2592', 'http://[::1]:3020'])(
		'allows %s',
		(url) => {
			expect(isLoopback(url)).toBe(true);
		}
	);

	it('reads the host, not the text: a public host that names localhost, another loopback address, or no URL at all is refused', () => {
		expect(isLoopback('http://localhost@relay.example.com/')).toBe(false);
		expect(isLoopback('http://localhost.example.com/')).toBe(false);
		expect(isLoopback('http://127.0.0.1.nip.io/')).toBe(false);
		expect(isLoopback('http://127.0.0.2:3010/')).toBe(false);
		expect(isLoopback('/xrpc/com.atproto.repo.getRecord')).toBe(false);
		expect(isLoopback(new URL('http://localhost:3010/xrpc/x'))).toBe(true);
	});
});

describe('outboundHandler, which every worker subrequest passes', () => {
	it('forwards a loopback request once, unchanged, and returns its answer', async () => {
		const { ledger, lines } = quietLedger();
		const answer = new Response('{"error":"InvalidToken"}', { status: 400 });
		const forward = vi.fn(async (request: Request) => {
			void request;
			return answer;
		});
		const request = new Request(
			'http://localhost:3020/xrpc/com.atproto.space.getRecord?repo=did:plc:a',
			{ headers: { authorization: 'Atproto-Space header.payload.signature' } }
		);

		const response = await outboundHandler(ledger, forward)(request);

		expect(forward).toHaveBeenCalledTimes(1);
		expect(forward.mock.calls[0][0]).toBe(request);
		expect(response).toBe(answer);
		expect(lines).toEqual([]);
		expect(ledger.verdict().detail).toBe(
			'public 0; local 1 (driver 0, worker 1) to localhost:3020'
		);
	});

	it('refuses a public request without forwarding it, with a status no check can read as a PDS refusal, and prints one line with no query', async () => {
		const { ledger, lines } = quietLedger();
		const forward = vi.fn(async () => new Response('should never be sent'));
		const request = new Request(
			'https://woodtuft.us-west.host.bsky.network/xrpc/com.atproto.space.getRecord?space=at://x',
			{ headers: { authorization: 'Atproto-Space header.payload.signature' } }
		);

		const response = await outboundHandler(ledger, forward)(request);

		expect(forward).not.toHaveBeenCalled();
		expect(response.ok).toBe(false);
		// A 4xx or a 501 is what a PDS that serves no spaces answers (check 18e),
		// and a 500 is what Miniflare makes of a thrown error.
		expect(response.status).toBe(599);
		expect(await response.text()).toContain('woodtuft.us-west.host.bsky.network');
		expect(lines).toEqual([
			'REFUSED worker GET https://woodtuft.us-west.host.bsky.network/xrpc/com.atproto.space.getRecord'
		]);
		expect(ledger.verdict()).toEqual({
			ok: false,
			detail: 'public 1; local 0 (driver 0, worker 0) to no host'
		});
	});
});

describe('guardFetch, which wraps the driver', () => {
	it('passes loopback requests to the real fetch as they came, by string, URL or Request', async () => {
		const { ledger } = quietLedger();
		const real = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			void input;
			void init;
			return new Response('{}');
		});
		const guarded = guardFetch(ledger, real);
		const init = { method: 'POST', body: '{}' };

		await guarded('http://localhost:3010/xrpc/com.atproto.server.createSession', init);
		await guarded(new URL('http://localhost:3010/xrpc/com.atproto.repo.getRecord?rkey=a'));
		await guarded(new Request('http://localhost:2592/did:plc:a'));

		expect(real).toHaveBeenCalledTimes(3);
		expect(real.mock.calls[0]).toEqual([
			'http://localhost:3010/xrpc/com.atproto.server.createSession',
			init
		]);
		expect(ledger.verdict().detail).toBe(
			'public 0; local 3 (driver 3, worker 0) to localhost:2592, localhost:3010'
		);
	});

	it('throws on a public request before the real fetch sees it', async () => {
		const { ledger, lines } = quietLedger();
		const real = vi.fn(async () => new Response('{}'));
		const guarded = guardFetch(ledger, real);

		await expect(
			guarded('https://plc.directory/did:plc:abc?x=1', { method: 'GET' })
		).rejects.toThrow('REFUSED driver GET https://plc.directory/did:plc:abc');
		await expect(
			guarded(new Request('https://bsky.network/xrpc/x', { method: 'POST', body: 'a' }))
		).rejects.toThrow('REFUSED driver POST https://bsky.network/xrpc/x');

		expect(real).not.toHaveBeenCalled();
		expect(lines).toEqual([
			'REFUSED driver GET https://plc.directory/did:plc:abc',
			'REFUSED driver POST https://bsky.network/xrpc/x'
		]);
	});
});

describe('the ledger behind check 24', () => {
	it('counts both kinds, and passes only with no public request and at least one local request from each side', () => {
		const { ledger } = quietLedger();
		expect(ledger.verdict()).toEqual({
			ok: false,
			detail: 'public 0; local 0 (driver 0, worker 0) to no host'
		});

		ledger.admit('driver', 'GET', 'http://localhost:2592/did:plc:a');
		expect(ledger.verdict().ok).toBe(false);

		ledger.admit('worker', 'GET', 'http://localhost:3020/xrpc/b');
		ledger.admit('worker', 'POST', 'http://localhost:3010/xrpc/a');
		expect(ledger.verdict()).toEqual({
			ok: true,
			detail:
				'public 0; local 3 (driver 1, worker 2) to localhost:2592, localhost:3010, localhost:3020'
		});

		expect(ledger.admit('worker', 'GET', 'https://slingshot.microcosm.blue/xrpc/x')).toBe(false);
		expect(ledger.verdict()).toEqual({
			ok: false,
			detail:
				'public 1; local 3 (driver 1, worker 2) to localhost:2592, localhost:3010, localhost:3020'
		});
	});

	it('does not let the startup lookups alone meet the driver floor', () => {
		const { ledger } = quietLedger();
		for (const did of ['a', 'b', 'c', 'd', 'e']) {
			ledger.admit('driver', 'GET', `http://localhost:2592/did:plc:${did}`);
		}
		ledger.startRun();
		ledger.admit('worker', 'GET', 'http://localhost:3010/xrpc/a');
		expect(ledger.verdict().ok).toBe(false);

		ledger.admit('driver', 'POST', 'http://localhost:3010/xrpc/com.atproto.server.createSession');
		expect(ledger.verdict()).toEqual({
			ok: true,
			detail: 'public 0; local 7 (driver 6, worker 1) to localhost:2592, localhost:3010'
		});
	});
});

describe('settingRefusals', () => {
	it('refuses a PDS or a PLC directory off this machine, naming the setting and its value', () => {
		expect(
			settingRefusals({ E2E_PDS: 'http://localhost:3010', E2E_PLC_URL: 'http://localhost:2592' })
		).toEqual([]);
		expect(
			settingRefusals({
				E2E_PDS: 'https://e2e-refusal.invalid',
				E2E_PLC_URL: 'https://plc.directory'
			})
		).toEqual([
			'REFUSED E2E_PDS https://e2e-refusal.invalid: not on this machine',
			'REFUSED E2E_PLC_URL https://plc.directory: not on this machine'
		]);
	});

	it('names a refused setting without the user or password it carries', () => {
		const refusals = settingRefusals({ E2E_PDS: 'https://someone:hunter2@pds.example.com/' });
		expect(refusals).toEqual(['REFUSED E2E_PDS https://pds.example.com/: not on this machine']);
		expect(refusals.join('')).not.toContain('hunter2');
	});
});

describe('fixtureCheck', () => {
	const PLC = 'http://localhost:2592';
	const SPACES_PDS = 'http://localhost:3010';

	/** A stand-in devnet PLC: each DID's PDS, or absent. */
	function devnetPlc(pdsByDid: Record<string, string>) {
		return vi.fn(async (input: RequestInfo | URL) => {
			const did = decodeURIComponent(new URL(String(input)).pathname.slice(1));
			const pds = pdsByDid[did];
			if (!pds) return Response.json({ message: `DID not registered: ${did}` }, { status: 404 });
			return Response.json({
				id: did,
				service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: pds }]
			});
		});
	}

	const fixtures: [string, string][] = [
		['E2E_GROUP_DID', 'did:plc:group'],
		['E2E_OWNER_DID', 'did:plc:owner'],
		['E2E_ADMIN_DID', 'did:plc:admin'],
		['E2E_OUTSIDER_DID', 'did:plc:outsider'],
		['E2E_NOSPACES_DID', 'did:plc:nospaces']
	];
	const onDevnet = {
		'did:plc:group': 'http://localhost:3010',
		'did:plc:owner': 'http://localhost:3010',
		'did:plc:admin': 'http://localhost:3010',
		'did:plc:outsider': 'http://localhost:3010',
		'did:plc:nospaces': 'http://localhost:3020'
	};

	it('asks the devnet PLC for every fixture and notes where each one lives', async () => {
		const fetch = devnetPlc(onDevnet);

		const result = await fixtureCheck({ plcUrl: PLC, spacesPds: SPACES_PDS, fixtures, fetch });

		expect(fetch).toHaveBeenCalledTimes(5);
		expect(result).toEqual({
			refusals: [],
			note: 'fixtures on devnet: 5 DIDs on http://localhost:2592; PDS http://localhost:3010 x4, http://localhost:3020 x1'
		});
	});

	it('refuses a fixture the devnet PLC lacks, one whose PDS is off this machine, and a no-spaces member on the PDS that serves spaces', async () => {
		const fetch = devnetPlc({
			...onDevnet,
			'did:plc:group': undefined as unknown as string,
			'did:plc:outsider': 'https://pds.example.com',
			'did:plc:nospaces': 'http://localhost:3010/'
		});

		const result = await fixtureCheck({ plcUrl: PLC, spacesPds: SPACES_PDS, fixtures, fetch });

		expect(result).toEqual({
			refusals: [
				'REFUSED fixture E2E_GROUP_DID did:plc:group: not on the devnet PLC',
				'REFUSED fixture E2E_OUTSIDER_DID did:plc:outsider: its PDS https://pds.example.com is not on this machine',
				'REFUSED fixture E2E_NOSPACES_DID did:plc:nospaces: hosted on E2E_PDS http://localhost:3010, which serves spaces'
			],
			note: null
		});
	});

	const onHttpsDevnet = {
		'did:plc:group': 'https://alpha.devnet.test',
		'did:plc:owner': 'https://alpha.devnet.test',
		'did:plc:admin': 'https://alpha.devnet.test',
		'did:plc:outsider': 'https://alpha.devnet.test',
		'did:plc:nospaces': 'https://regular.devnet.test'
	};

	it('accepts fixtures on PDS names this run resolves to this machine, and adds each such name to the set the run shares', async () => {
		// What the run holds once it has resolved E2E_PDS and E2E_PLC_URL.
		const names = new Set(['alpha.devnet.test', 'plc.directory']);
		const lookup = resolver({ 'regular.devnet.test': ['127.0.0.1'] });
		const fetch = devnetPlc(onHttpsDevnet);

		const result = await fixtureCheck({
			plcUrl: 'https://plc.directory',
			spacesPds: 'https://alpha.devnet.test',
			fixtures,
			fetch,
			names,
			lookup
		});

		expect(result).toEqual({
			refusals: [],
			note: 'fixtures on devnet: 5 DIDs on https://plc.directory; PDS https://alpha.devnet.test x4, https://regular.devnet.test x1'
		});
		// Only the one name not yet known was looked up.
		expect(lookup.mock.calls).toEqual([['regular.devnet.test', { all: true }]]);
		expect([...names].sort()).toEqual([
			'alpha.devnet.test',
			'plc.directory',
			'regular.devnet.test'
		]);
	});

	it('still refuses a no-spaces member on the PDS that serves spaces, and a PDS name that does not resolve to this machine alone', async () => {
		const names = new Set(['alpha.devnet.test', 'plc.directory']);
		const lookup = resolver({ 'pds.example.com': ['203.0.113.7'] });
		const fetch = devnetPlc({
			...onHttpsDevnet,
			'did:plc:owner': 'https://pds.example.com',
			'did:plc:admin': 'https://unmapped.devnet.test',
			'did:plc:nospaces': 'https://alpha.devnet.test'
		});

		const result = await fixtureCheck({
			plcUrl: 'https://plc.directory',
			spacesPds: 'https://alpha.devnet.test',
			fixtures,
			fetch,
			names,
			lookup
		});

		expect(result).toEqual({
			refusals: [
				'REFUSED fixture E2E_OWNER_DID did:plc:owner: its PDS https://pds.example.com is not on this machine',
				'REFUSED fixture E2E_ADMIN_DID did:plc:admin: its PDS https://unmapped.devnet.test is not on this machine',
				'REFUSED fixture E2E_NOSPACES_DID did:plc:nospaces: hosted on E2E_PDS https://alpha.devnet.test, which serves spaces'
			],
			note: null
		});
		expect([...names].sort()).toEqual(['alpha.devnet.test', 'plc.directory']);
	});

	it('looks nothing up for fixtures on localhost, nor for any fixture when the run passes no set', async () => {
		const lookup = resolver({ 'alpha.devnet.test': ['127.0.0.1'] });

		const local = await fixtureCheck({
			plcUrl: PLC,
			spacesPds: SPACES_PDS,
			fixtures,
			fetch: devnetPlc(onDevnet),
			names: new Set(),
			lookup
		});
		const noSet = await fixtureCheck({
			plcUrl: PLC,
			spacesPds: SPACES_PDS,
			fixtures,
			fetch: devnetPlc({ ...onDevnet, 'did:plc:group': 'https://alpha.devnet.test' }),
			lookup
		});

		expect(lookup).not.toHaveBeenCalled();
		expect(local.note).toBe(
			'fixtures on devnet: 5 DIDs on http://localhost:2592; PDS http://localhost:3010 x4, http://localhost:3020 x1'
		);
		expect(noSet.refusals).toEqual([
			'REFUSED fixture E2E_GROUP_DID did:plc:group: its PDS https://alpha.devnet.test is not on this machine'
		]);
	});
});

describe('localNames, which admits a devnet name by the answer this run gets for it, never by its text', () => {
	it('admits a name whose every address is 127.0.0.1 or ::1, asking for all of them', async () => {
		const lookup = resolver({
			'alpha.devnet.test': ['127.0.0.1'],
			'plc.directory': ['127.0.0.1', '::1']
		});

		const names = await localNames(['alpha.devnet.test', 'plc.directory'], lookup);

		expect([...names]).toEqual(['alpha.devnet.test', 'plc.directory']);
		expect(lookup.mock.calls).toEqual([
			['alpha.devnet.test', { all: true }],
			['plc.directory', { all: true }]
		]);
	});

	it.each([
		['a mixed answer', ['127.0.0.1', '203.0.113.7']],
		['a public answer', ['203.0.113.7']],
		['another loopback address', ['127.0.0.2']],
		['a mapped loopback address', ['::ffff:127.0.0.1']],
		['an empty answer', []]
	])('refuses %s', async (_, addresses) => {
		const names = await localNames(
			['alpha.devnet.test'],
			resolver({ 'alpha.devnet.test': addresses })
		);

		expect(names.size).toBe(0);
	});

	it('refuses a name whose lookup fails, without throwing, and still admits the next one', async () => {
		const throwsAtOnce = vi.fn((name: string) => {
			throw new Error(`no resolver for ${name}`);
		});

		await expect(localNames(['alpha.devnet.test'], throwsAtOnce)).resolves.toEqual(new Set());
		const names = await localNames(
			['regular.devnet.test', 'alpha.devnet.test'],
			resolver({ 'alpha.devnet.test': ['::1'] })
		);
		expect([...names]).toEqual(['alpha.devnet.test']);
	});
});

describe('isLocal, the classifier the guard uses once names are resolved', () => {
	it('admits a loopback URL, or a URL whose parsed hostname is in the set, and nothing else', () => {
		const names = new Set(['alpha.devnet.test']);

		expect(isLocal('http://localhost:3010/xrpc/x', new Set())).toBe(true);
		expect(isLocal('https://alpha.devnet.test/xrpc/x', names)).toBe(true);
		expect(isLocal('https://alpha.devnet.test/xrpc/x', new Set())).toBe(false);
		expect(isLocal('https://regular.devnet.test/xrpc/x', names)).toBe(false);
		expect(isLocal('https://alpha.devnet.test@pds.example.com/', names)).toBe(false);
		expect(isLocal('https://alpha.devnet.test.example.com/', names)).toBe(false);
		expect(isLocal('/xrpc/com.atproto.repo.getRecord', names)).toBe(false);
	});

	it('lets the ledger count a resolved name as local, still refuse one not in the set, and see a name added later', () => {
		const names = new Set(['alpha.devnet.test', 'plc.directory']);
		const lines: string[] = [];
		const ledger = createLedger((line: string) => lines.push(line), names);

		expect(ledger.admit('driver', 'GET', 'https://plc.directory/did:plc:a')).toBe(true);
		expect(ledger.admit('worker', 'POST', 'https://alpha.devnet.test/xrpc/a')).toBe(true);
		expect(ledger.admit('worker', 'GET', 'https://regular.devnet.test/xrpc/b?q=1')).toBe(false);
		names.add('regular.devnet.test');
		expect(ledger.admit('worker', 'GET', 'https://regular.devnet.test/xrpc/b')).toBe(true);

		expect(lines).toEqual(['REFUSED worker GET https://regular.devnet.test/xrpc/b']);
		expect(ledger.verdict().detail).toBe(
			'public 1; local 3 (driver 1, worker 2) to alpha.devnet.test, plc.directory, regular.devnet.test'
		);
	});

	it('lets settingRefusals admit https://alpha.devnet.test and https://plc.directory only when they are in the set', () => {
		const settings = { E2E_PDS: 'https://alpha.devnet.test', E2E_PLC_URL: 'https://plc.directory' };

		expect(settingRefusals(settings, new Set(['alpha.devnet.test', 'plc.directory']))).toEqual([]);
		expect(settingRefusals(settings, new Set(['alpha.devnet.test']))).toEqual([
			'REFUSED E2E_PLC_URL https://plc.directory: not on this machine'
		]);
		expect(settingRefusals(settings)).toEqual([
			'REFUSED E2E_PDS https://alpha.devnet.test: not on this machine',
			'REFUSED E2E_PLC_URL https://plc.directory: not on this machine'
		]);
	});
});

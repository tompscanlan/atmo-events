import { describe, expect, it, vi } from 'vitest';
import {
	createLedger,
	fixtureCheck,
	guardFetch,
	isLoopback,
	outboundHandler,
	settingRefusals
} from './groups-e2e.network.mjs';

/** A ledger whose REFUSED lines land in an array instead of the console. */
function quietLedger() {
	const lines: string[] = [];
	return { ledger: createLedger((line: string) => lines.push(line)), lines };
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
		expect(response.status >= 400 && response.status < 500).toBe(false);
		expect([500, 501]).not.toContain(response.status);
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
});

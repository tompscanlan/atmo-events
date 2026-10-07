// The groups e2e's network guard: it runs on devnet only, so no request may
// leave this machine. Imported by groups-e2e.mjs and tested by
// groups-e2e.network.test.ts. Nothing here runs on import: it holds the host
// classifier, the ledger behind check 24, the Miniflare outbound handler every
// worker subrequest passes, the wrapper around the driver's own fetch, and the
// startup checks that refuse a setting or a fixture off this machine.

/** The only hosts that are this machine. A devnet name such as
 *  regular.devnet.test is not one: it would need a resolver to reach. */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** What the outbound handler answers for a refused request. Not a 4xx or a
 *  501, which check 18e reads as a PDS that serves no spaces, and not a 500,
 *  which is what Miniflare makes of a thrown error. */
const REFUSED_STATUS = 599;

/** The fixture that must not live on the PDS that serves spaces. */
const NO_SPACES_FIXTURE = 'E2E_NOSPACES_DID';

/** @param {string | URL} url */
function parse(url) {
	try {
		return new URL(String(url));
	} catch {
		return null;
	}
}

/**
 * Whether a URL's host is this machine. The parsed hostname decides, never the
 * text, so `http://localhost@host.example/` is public.
 * @param {string | URL} url
 */
export function isLoopback(url) {
	const parsed = parse(url);
	return parsed !== null && LOOPBACK_HOSTNAMES.has(parsed.hostname);
}

/**
 * A request as a REFUSED line names it: method, scheme, host and path, with no
 * query and no headers.
 * @param {string} method
 * @param {string | URL} url
 */
function target(method, url) {
	const parsed = parse(url);
	const where = parsed ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : String(url);
	return `${method.toUpperCase()} ${where}`;
}

/**
 * One run's count of requests, from the driver and from the worker. Local ones
 * are counted by host; every other one is refused and printed as it happens.
 * @param {(line: string) => void} [log]
 */
export function createLedger(log = console.log) {
	const local = { driver: 0, worker: 0 };
	let driverAtStart = 0;
	/** @type {Set<string>} */
	const hosts = new Set();
	/** @type {string[]} */
	const refused = [];
	return {
		/**
		 * Counts one request and says whether it may go.
		 * @param {'driver' | 'worker'} source
		 * @param {string} method
		 * @param {string | URL} url
		 */
		admit(source, method, url) {
			if (isLoopback(url)) {
				local[source] += 1;
				hosts.add(/** @type {URL} */ (parse(url)).host);
				return true;
			}
			const line = `REFUSED ${source} ${target(method, url)}`;
			refused.push(line);
			log(line);
			return false;
		},
		/** Marks the end of the startup checks, whose lookups do not count toward
		 *  the driver's floor in the verdict. */
		startRun() {
			driverAtStart = local.driver;
		},
		/** Check 24: no public request, and both the worker and the driver past its
		 *  startup checks were seen, so a ledger that counted nothing cannot pass. */
		verdict() {
			const total = local.driver + local.worker;
			const to = [...hosts].sort().join(', ') || 'no host';
			return {
				ok: refused.length === 0 && local.driver > driverAtStart && local.worker >= 1,
				detail: `public ${refused.length}; local ${total} (driver ${local.driver}, worker ${local.worker}) to ${to}`
			};
		}
	};
}

/**
 * Miniflare's `outboundService`: workerd hands it every subrequest the worker
 * sends, including those from fetch references taken at module load. A
 * loopback request goes to `forward` as it came; any other is refused with an
 * answer and never sent.
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {(request: Request) => Promise<Response> | Response} forward
 */
export function outboundHandler(ledger, forward) {
	/** @param {Request} request */
	return async (request) => {
		if (ledger.admit('worker', request.method, request.url)) return forward(request);
		const host = parse(request.url)?.host ?? request.url;
		return new Response(`refused by the groups e2e: ${host} is not on this machine`, {
			status: REFUSED_STATUS,
			headers: { 'content-type': 'text/plain' }
		});
	};
}

/**
 * A `fetch` for the driver: a loopback request goes to `real` as it came; any
 * other throws before it is sent.
 * @param {ReturnType<typeof createLedger>} ledger
 * @param {typeof fetch} real
 * @returns {typeof fetch}
 */
export function guardFetch(ledger, real) {
	return async (input, init) => {
		const request = input instanceof Request ? input : null;
		const url = request ? request.url : String(input);
		const method = init?.method ?? request?.method ?? 'GET';
		if (!ledger.admit('driver', method, url)) {
			throw new Error(`REFUSED driver ${target(method, url)}: not on this machine`);
		}
		return real(input, init);
	};
}

/**
 * A setting as a refusal names it, without any user or password it carries.
 * @param {string} url
 */
function shown(url) {
	const parsed = parse(url);
	if (!parsed || (!parsed.username && !parsed.password)) return url;
	parsed.username = '';
	parsed.password = '';
	return parsed.href;
}

/**
 * Refusals for a PDS or PLC directory setting off this machine.
 * @param {Record<string, string>} settings name to URL
 */
export function settingRefusals(settings) {
	return Object.entries(settings)
		.filter(([, url]) => !isLoopback(url))
		.map(([name, url]) => `REFUSED ${name} ${shown(url)}: not on this machine`);
}

/**
 * The PDS a DID document names.
 * @param {any} doc
 * @returns {string | null}
 */
function pdsOf(doc) {
	/** @type {any[]} */
	const services = Array.isArray(doc?.service) ? doc.service : [];
	const pds = services.find((s) => typeof s?.id === 'string' && s.id.endsWith('#atproto_pds'));
	return typeof pds?.serviceEndpoint === 'string' ? pds.serviceEndpoint : null;
}

/**
 * Asks the devnet PLC for every fixture DID. Each must be there, hosted on this
 * machine, and the no-spaces member not on the PDS that serves spaces. Returns
 * the refusals, or none and the note naming where the fixtures live.
 * @param {{ plcUrl: string, spacesPds: string, fixtures: [string, string][],
 *   fetch: (input: string) => Promise<Response> }} options
 */
export async function fixtureCheck({ plcUrl, spacesPds, fixtures, fetch }) {
	/** @type {string[]} */
	const refusals = [];
	/** @type {Map<string, number>} */
	const perPds = new Map();
	for (const [name, did] of fixtures) {
		const refuse = (/** @type {string} */ why) =>
			refusals.push(`REFUSED fixture ${name} ${did}: ${why}`);
		let response;
		try {
			response = await fetch(new URL(`/${encodeURIComponent(did)}`, plcUrl).href);
		} catch (error) {
			refuse(`the devnet PLC did not answer (${/** @type {Error} */ (error).message})`);
			continue;
		}
		if (response.status === 404) {
			refuse('not on the devnet PLC');
			continue;
		}
		if (!response.ok) {
			refuse(`the devnet PLC answered ${response.status}`);
			continue;
		}
		const pds = pdsOf(await response.json().catch(() => null));
		if (!pds) refuse('its devnet DID document names no PDS');
		else if (!isLoopback(pds)) refuse(`its PDS ${pds} is not on this machine`);
		else if (name === NO_SPACES_FIXTURE && parse(pds)?.origin === parse(spacesPds)?.origin) {
			refuse(`hosted on E2E_PDS ${spacesPds}, which serves spaces`);
		} else {
			const origin = /** @type {URL} */ (parse(pds)).origin;
			perPds.set(origin, (perPds.get(origin) ?? 0) + 1);
		}
	}
	if (refusals.length > 0) return { refusals, note: null };
	const counts = [...perPds.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([pds, n]) => `${pds} x${n}`)
		.join(', ');
	return {
		refusals,
		note: `fixtures on devnet: ${fixtures.length} DIDs on ${plcUrl}; PDS ${counts}`
	};
}

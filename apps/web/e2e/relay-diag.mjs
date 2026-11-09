#!/usr/bin/env node
// Link-a-group through atmo's real pages, on a network with a group host. Harness only: it is not part
// of any PR. The group is made at the host by a plain loopback OAuth app of this script's own, since
// making a group through atmo is the members layer's. Every write is read back from the group host's
// repo or a fresh page load, not trusted from what a page said. Prints statuses, never a password, and
// never reads or captures the host's recovery key page: it only clicks Continue there.
//
//   SG_FILE=<the network file> pnpm exec snowglobe run --app e2e -- node apps/web/e2e/groups-link.walk.mjs
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { OAuthClient, MemoryStore } = await import('@atcute/oauth-node-client');
const {
	CompositeDidDocumentResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} = await import('@atcute/identity-resolver');

const need = (n) => {
	const v = process.env[n]?.trim();
	if (!v) throw new Error(`${n} not set`);
	return v;
};
const ATMO = need('E2E_ATMO');
const HOST = need('E2E_GROUP_HOST');
const PLC = need('E2E_PLC_URL');
const CRON_SECRET = need('E2E_CRON_SECRET');
const RELAY = need('E2E_RELAY_URL');
const person = (role, name) => ({
	name,
	handle: need(`E2E_${role}_HANDLE`),
	password: need(`E2E_${role}_PASSWORD`)
});
const ALICE = person('OWNER', 'alice');
const BOB = person('MEMBER', 'bob');

const secrets = [ALICE.password, BOB.password];
const mask = (s) => secrets.reduce((t, x) => t.split(x).join('<masked>'), String(s));
const log = (...a) => console.log(mask(a.join(' ')));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = Date.now().toString(36);
const LABEL = `lk${RUN}`;
const NAME = `Hill walkers ${RUN}`;
const EVENT = `Ridge walk ${RUN}`;
const RENAMED = `${EVENT} at eight`;
const META = 'group.opensocial.meta';
const EVENTS = 'community.lexicon.calendar.event';
const DECLARATION = 'group.opensocial.declaration';

let passed = 0;
let failed = 0;
function check(label, ok, detail) {
	log(
		`${ok ? 'PASS' : 'FAIL'} ${passed + failed + 1}. ${label}${!ok && detail ? `: ${detail}` : ''}`
	);
	if (ok) passed++;
	else failed++;
	return ok;
}

const browser = await chromium.launch();
let pageErrors = 0;
async function pageFor(who) {
	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const page = await ctx.newPage();
	page.on('pageerror', (e) => {
		pageErrors++;
		log(`  [${who}] browser error: ${mask(e.message).slice(0, 200)}`);
	});
	return page;
}
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
const main = async (page) =>
	(await page.locator('main').innerText({ timeout: 15_000 })).replace(/\s+/g, ' ');

/** The PDS and group host pages a click led to, until `done(url)`. Never reads the recovery page. */
async function through(page, who, done, { label } = {}) {
	for (let i = 0; i < 200; i++) {
		const u = new URL(page.url());
		if (done(u)) return;
		if (
			u.origin === HOST &&
			(await page
				.locator('#recovery')
				.count()
				.catch(() => 0))
		) {
			await page.click('#continue');
			await page.locator('#recovery').waitFor({ state: 'detached', timeout: 45_000 });
			continue;
		}
		if (
			u.origin === HOST &&
			(await page
				.locator('#consent')
				.isVisible()
				.catch(() => false))
		) {
			await page.click('#go');
			await sleep(1000);
			continue;
		}
		if (u.origin === HOST && label && (await page.locator('input[name=label]').count())) {
			await page.fill('input[name=label]', label);
			await page.fill('input[name=handle]', who.handle);
			await page.locator('form button').first().click();
			await page.locator('input[name=label]').waitFor({ state: 'detached', timeout: 45_000 });
			continue;
		}
		if (u.origin === HOST && (await page.locator('form input[name=handle]').count())) {
			await page.fill('input[name=handle]', who.handle);
			await page.locator('form button').first().click();
			await page.locator('form input[name=handle]').waitFor({ state: 'detached', timeout: 45_000 });
			continue;
		}
		const pw = page.locator('input[name=password]');
		if (await pw.isVisible().catch(() => false)) {
			const user = page.locator('input[name=username]');
			if ((await user.count()) && (await user.isEditable()) && !(await user.inputValue())) {
				await user.fill(who.handle);
			}
			await pw.fill(who.password);
			await page.locator('button[type=submit]').last().click();
			await sleep(800);
			continue;
		}
		const btn = page.getByRole('button', { name: /^(accept|authorize|allow(?! atmo))/i }).first();
		if (u.origin !== new URL(ATMO).origin && (await btn.isVisible().catch(() => false))) {
			await btn.click({ timeout: 10_000 });
			await sleep(800);
			continue;
		}
		await sleep(400);
	}
	throw new Error(`stuck for ${who.name} at ${page.url().split('?')[0]}`);
}

async function signIn(who) {
	const page = await pageFor(who.name);
	await page.goto(ATMO, { waitUntil: 'networkidle', timeout: 60_000 });
	await page
		.getByRole('button', { name: /^log in$/i })
		.first()
		.click();
	await page.locator('input[name=handle]').last().fill(who.handle);
	await page
		.getByRole('button', { name: /^log in/i })
		.last()
		.click();
	await page.getByRole('button', { name: /^continue to log in/i }).click({ timeout: 15_000 });
	await page.waitForURL((u) => u.origin !== new URL(ATMO).origin, { timeout: 30_000 });
	await through(page, who, (u) => u.origin === new URL(ATMO).origin);
	await settle(page);
	return page;
}

// ---------- the group host, read directly ----------
async function repoRecords(did, collection) {
	const url = `${HOST}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: did, collection })}`;
	const body = await (await fetch(url)).json();
	return (body.records ?? []).map((r) => ({ rkey: r.uri.split('/').pop(), value: r.value }));
}
async function handleOf(did) {
	const doc = await (await fetch(`${PLC}/${did}`)).json();
	const aka = (doc.alsoKnownAs ?? []).find((a) => a.startsWith('at://'));
	return aka ? aka.slice('at://'.length) : null;
}
async function until(read, want, tries = 40) {
	let last;
	for (let i = 0; i < tries; i++) {
		last = await read();
		if (want(last)) return { ok: true, last };
		await sleep(250);
	}
	return { ok: false, last };
}
/** One ingest cycle, as the built Worker's own scheduled() sends it: what atmo's index learns
 *  from the network's Jetstream, rather than from a page that tells it. */
async function runCron() {
	const r = await fetch(`${ATMO}/api/cron`, {
		method: 'POST',
		headers: { 'X-Cron-Secret': CRON_SECRET, 'content-type': 'application/json' }
	});
	if (!r.ok) throw new Error(`atmo's cron: ${r.status}`);
}

// ---------- making the group, as any app could ----------
const CB_PORT = 39421;
const REDIRECT = `http://127.0.0.1:${CB_PORT}/cb`;
const SCOPES = [
	'atproto',
	`space:${META}?authority=self&action=read`,
	'include:group.opensocial.configure',
	'include:group.opensocial.manageSpaces'
].join(' ');
/** For a group that lists itself, as another app could, without atmo. */
const DECLARING = `${SCOPES} repo:${DECLARATION}`;

async function makeGroup(who, label = LABEL, scopes = SCOPES) {
	const app = new OAuthClient({
		metadata: { redirect_uris: [REDIRECT], scope: scopes },
		actorResolver: new LocalActorResolver({
			handleResolver: new WellKnownHandleResolver(),
			didDocumentResolver: new CompositeDidDocumentResolver({
				methods: {
					plc: new PlcDidDocumentResolver({ apiUrl: PLC }),
					web: new WebDidDocumentResolver()
				}
			})
		}),
		stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) }
	});
	const { url } = await app.authorize({
		target: { type: 'pds', serviceUrl: HOST },
		scope: scopes,
		prompt: 'create'
	});
	let cb = null;
	const server = http.createServer((rq, rs) => {
		cb = new URL(rq.url, REDIRECT);
		rs.end('ok');
	});
	await new Promise((r) => server.listen(CB_PORT, '127.0.0.1', r));
	try {
		const page = await pageFor('maker');
		await page.goto(url.toString(), { waitUntil: 'load', timeout: 60_000 });
		await through(page, who, () => cb !== null, { label });
		await page.context().close();
	} finally {
		await new Promise((r) => server.close(r));
	}
	const { session } = await app.callback(cb.searchParams);
	return session;
}

async function asGroup(session, nsid, init) {
	const res = await session.handle(`/xrpc/${nsid}`, init);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(`${nsid} answered ${res.status} ${body.error ?? ''}`);
	return body;
}
async function putMeta(session, did, collection, change) {
	const space = `at://${did}/space/${META}/self`;
	const now = await asGroup(
		session,
		`com.atproto.space.getRecord?${new URLSearchParams({ space, repo: did, collection, rkey: 'self' })}`,
		{ method: 'GET' }
	).catch(() => ({ value: {} }));
	await asGroup(session, 'com.atproto.space.putRecord', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space,
			repo: did,
			collection,
			rkey: 'self',
			record: { ...(now.value ?? {}), ...change, $type: collection }
		})
	});
}

// ---------- relay diagnostic (om-7coam) ----------
// Does a write at the group host reach the relay's firehose? Watches the host's own feed and the
// relay's, then makes a group and puts its declaration, then asks the relay what it knows.
// CRAWL=public asks the relay's public requestCrawl first; anything else leaves the crawl to the
// caller (an admin crawl from inside the relay container, or none).
const CRAWL = process.env.CRAWL ?? 'none';
const wsUrl = (base) => {
	const u = new URL('/xrpc/com.atproto.sync.subscribeRepos', base);
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	return u.toString();
};
const TYPES = ['#commit', '#identity', '#account', '#sync', '#info'];
function watch(name, url) {
	const seen = { name, frames: 0, types: {}, byDid: {}, times: {}, opened: false, error: null };
	const ws = new WebSocket(url);
	ws.binaryType = 'arraybuffer';
	ws.onopen = () => (seen.opened = true);
	ws.onerror = (e) => (seen.error = String(e?.message ?? e?.error ?? 'error'));
	ws.onmessage = (m) => {
		const text = Buffer.from(m.data).toString('latin1');
		seen.frames++;
		const t = TYPES.find((x) => text.slice(0, 40).includes(x)) ?? 'other';
		seen.types[t] = (seen.types[t] ?? 0) + 1;
		const times = text.match(/20\d\d-\d\d-\d\dT[0-9:.]+Z/g) ?? [];
		for (const d of new Set(text.match(/did:plc:[a-z2-7]{24}/g) ?? [])) {
			seen.byDid[d] ??= {};
			seen.byDid[d][t] = (seen.byDid[d][t] ?? 0) + 1;
			(seen.times[d] ??= []).push(`${t} ${times.join(',')} got ${new Date().toISOString()}`);
		}
	};
	return { seen, close: () => ws.close() };
}
const get = async (path) => {
	const r = await fetch(new URL(path, RELAY));
	return `${r.status} ${(await r.text()).slice(0, 300)}`;
};

const JETSTREAM = need('E2E_JETSTREAM_URL');
function watchJetstream(name, query) {
	const u = new URL(`/subscribe${query}`, JETSTREAM);
	u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
	const seen = {
		name,
		url: u.pathname + u.search,
		frames: 0,
		kinds: {},
		events: {},
		opened: false,
		error: null
	};
	const ws = new WebSocket(u);
	ws.onopen = () => (seen.opened = true);
	ws.onerror = (e) => (seen.error = String(e?.message ?? e?.error ?? 'error'));
	ws.onmessage = (m) => {
		seen.frames++;
		let ev;
		try {
			ev = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
		} catch {
			seen.kinds.unparsed = (seen.kinds.unparsed ?? 0) + 1;
			return;
		}
		seen.kinds[ev.kind] = (seen.kinds[ev.kind] ?? 0) + 1;
		(seen.events[ev.did] ??= []).push(
			`${ev.kind} ${ev.commit?.operation ?? ''} ${ev.commit?.collection ?? ''} time_us ${ev.time_us} (${new Date(ev.time_us / 1000).toISOString()}) got ${new Date().toISOString()}`
		);
	};
	return { seen, close: () => ws.close() };
}
// Jetstream v2, read as contrail reads it: @bsky/jetstream's live() from a seq cursor.
const { pathToFileURL, fileURLToPath } = await import('node:url');
const { realpathSync } = await import('node:fs');
const contrailReq = createRequire(
	realpathSync(
		fileURLToPath(new URL('../node_modules/@atmo-dev/contrail/package.json', import.meta.url))
	)
);
const { Jetstream } = await import(pathToFileURL(contrailReq.resolve('@bsky/jetstream')).href);
function watchV2(name, opts) {
	const seen = { name, frames: 0, kinds: {}, events: {}, error: null, lastSeq: null };
	const ac = new AbortController();
	(async () => {
		try {
			const js = new Jetstream(JETSTREAM);
			for await (const ev of js.live({
				raw: true,
				signal: ac.signal,
				cursor: { load: async () => 0, save: async () => {} },
				...opts
			})) {
				seen.frames++;
				seen.kinds[ev.kind] = (seen.kinds[ev.kind] ?? 0) + 1;
				seen.lastSeq = ev.seq ?? ev.cursor ?? null;
				(seen.events[ev.did] ??= []).push(
					`${ev.kind} ${ev.commit?.operation ?? ''} ${ev.commit?.collection ?? ''} seq ${ev.seq ?? '?'} got ${new Date().toISOString()}`
				);
			}
		} catch (e) {
			if (!ac.signal.aborted) seen.error = String(e?.message ?? e);
		}
	})();
	return { seen, close: () => ac.abort() };
}
/** A fresh v2 reader from a cursor, as contrail opens one each cron: what it gets in `ms`. */
async function replayV2(cursor, ms, opts) {
	const got = [];
	const ac = new AbortController();
	const t = setTimeout(() => ac.abort(), ms);
	try {
		const js = new Jetstream(JETSTREAM);
		for await (const ev of js.live({
			raw: true,
			signal: ac.signal,
			cursor: { load: async () => cursor, save: async () => {} },
			...opts
		})) {
			got.push(
				`${ev.seq}:${ev.kind}${ev.commit ? ':' + ev.commit.collection : ''}:${ev.did.slice(-6)}`
			);
		}
	} catch (e) {
		if (!ac.signal.aborted) got.push(`error ${String(e?.message ?? e)}`);
	} finally {
		clearTimeout(t);
	}
	return got;
}
const v2All = watchV2('jetstream v2, all', {});
const v2Contrail = watchV2('jetstream v2, as contrail asks', {
	collections: [DECLARATION, EVENTS],
	kinds: ['commit', 'identity', 'account']
});
const jsAll = watchJetstream('jetstream, all', '');
const jsDecl = watchJetstream('jetstream, declarations', `?wantedCollections=${DECLARATION}`);
const hostFeed = watch('group host feed', wsUrl(HOST));
const relayFeed = watch('relay feed', wsUrl(RELAY));
await sleep(2000);
if (CRAWL === 'public') {
	const r = await fetch(new URL('/xrpc/com.atproto.sync.requestCrawl', RELAY), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ hostname: new URL(HOST).hostname })
	});
	log(`public requestCrawl: ${r.status} ${(await r.text()).slice(0, 200)}`);
}
await sleep(3000);
try {
	const group = await makeGroup(ALICE, `${LABEL}d`, `${SCOPES} repo:${DECLARATION}`);
	log(`group ${group.did} ${await handleOf(group.did)}`);
	await putMeta(group, group.did, 'group.opensocial.access', { public: true });
	await asGroup(group, 'com.atproto.repo.putRecord', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			repo: group.did,
			collection: DECLARATION,
			rkey: 'self',
			record: { $type: DECLARATION, meta: `at://${group.did}/space/${META}/self` }
		})
	});
	log('declaration put; waiting 20 s for the feeds');
	await sleep(20_000);
	for (const f of [hostFeed, relayFeed]) {
		const s = f.seen;
		log(
			`${s.name}: opened ${s.opened} error ${s.error} frames ${s.frames} ${JSON.stringify(s.types)}`
		);
		log(`  the group: ${JSON.stringify(s.byDid[group.did] ?? {})}`);
		for (const line of s.times[group.did] ?? []) log(`    ${line}`);
	}
	for (const f of [v2All, v2Contrail]) {
		const s = f.seen;
		log(
			`${s.name}: error ${s.error} frames ${s.frames} ${JSON.stringify(s.kinds)} last seq ${s.lastSeq}`
		);
		log(
			`  dids: ${Object.keys(s.events)
				.map((d) => `${d.slice(-6)}:${s.events[d].length}`)
				.join(' ')}`
		);
		for (const line of s.events[group.did] ?? ['  (none for the group)']) log(`    ${line}`);
	}
	const groupSeqs = (v2All.seen.events[group.did] ?? [])
		.map((l) => Number(/seq (\d+)/.exec(l)?.[1]))
		.filter(Number.isFinite);
	const first = Math.min(...groupSeqs);
	for (const [cursor, opts, label] of [
		[
			first - 1,
			{ collections: [DECLARATION, EVENTS], kinds: ['commit', 'identity', 'account'] },
			'as contrail asks'
		],
		[first - 1, {}, 'everything'],
		[0, {}, 'everything']
	]) {
		const got = await replayV2(cursor, 10_000, opts);
		log(
			`fresh v2 reader from cursor ${cursor} (${label}), 10 s: ${got.length} events: ${got.slice(-6).join(' ')}`
		);
	}
	for (const f of [jsAll, jsDecl]) {
		const s = f.seen;
		log(
			`${s.name} ${s.url}: opened ${s.opened} error ${s.error} frames ${s.frames} ${JSON.stringify(s.kinds)}`
		);
		log(
			`  dids: ${Object.keys(s.events)
				.map((d) => `${d.slice(-6)}:${s.events[d].length}`)
				.join(' ')}`
		);
		for (const line of s.events[group.did] ?? ['  (none for the group)']) log(`    ${line}`);
		const other = Object.keys(s.events).find((d) => d !== group.did);
		if (other) log(`  last for ${other}: ${s.events[other].at(-1)}`);
	}
	log(`relay listHosts: ${await get('/xrpc/com.atproto.sync.listHosts?limit=50')}`);
	log(
		`relay getHostStatus: ${await get(`/xrpc/com.atproto.sync.getHostStatus?hostname=${new URL(HOST).hostname}`)}`
	);
	log(`relay getRepoStatus: ${await get(`/xrpc/com.atproto.sync.getRepoStatus?did=${group.did}`)}`);
	log(
		`relay getLatestCommit: ${await get(`/xrpc/com.atproto.sync.getLatestCommit?did=${group.did}`)}`
	);
} catch (e) {
	log(`diag stopped: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
} finally {
	hostFeed.close();
	relayFeed.close();
	jsAll.close();
	jsDecl.close();
	v2All.close();
	v2Contrail.close();
	await browser.close();
}
process.exit(0);

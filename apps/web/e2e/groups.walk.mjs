#!/usr/bin/env node
// A walk of atmo's groups feature through its real pages, on a test network that has an Atmosphere
// Groups host (group-host, spec namespace org.atgrp). Harness only: it is not part of any PR.
//
// Groups are made at the host by script, the host's own createGroup, as their founder's PDS vouches
// for it. Everything else goes through the pages: signing in to atmo at the person's own PDS,
// linking a group through the host's console approval page (where the person signs in again at their
// own PDS), listing and unlisting, posting events as the group. Each write is read back from the
// group host's repo or from a fresh page load, not taken from what a page said. It prints statuses,
// never a password or a token, and it never reads the group host's recovery key page.
//
// The walk is a list of numbered, named steps in sections, so later parts (create a group from the
// app, join, roster, members-only events) can be added as further sections. A step that needs another
// runs after it, and is reported as blocked when that one failed. Choose by section or step name:
//
//   WALK_ONLY=link        the link-a-group section (and the setup steps it needs)
//   WALK_ONLY=flags,private
//
// Run it from the repository root, with atmo's dev server up on the network (see snowglobe.groups.yml
// for the commands), under `snowglobe run --app atmo --`, which gives it the network's addresses and
// makes Node trust its CA:
//
//   WALK_EVIDENCE_DIR=<folder> WALK_ATMO_LOG=<the dev server's log> \
//     snowglobe run --app atmo -- node apps/web/e2e/groups.walk.mjs
//
// Settings read from the environment (the ones atmo's own block in the network file sets):
//   OAUTH_PUBLIC_URL, GROUP_HOST_URL, GROUP_HOST_DID, PUBLIC_PLC_URL, SPACES_PDS_URL (alice's and
//   bob's PDS), PUBLIC_RELAY_URLS, PUBLIC_JETSTREAM_URL
// and, for the walk itself:
//   WALK_ACCOUNTS_ENV   the network's accounts.env (default: <state>/<globe>/accounts.env)
//   WALK_CRON_SECRET    atmo's CRON_SECRET (default local-network-only)
//   WALK_ATMO_LOG       the dev server's log, for the lines the walk looks for
//   WALK_EVIDENCE_DIR   where walk.txt, walk.har, the screenshots and the server logs are written
//   WALK_ONLY           sections or step names to run, comma separated
import { execFileSync } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

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

// ---------- settings ----------
const need = (n) => {
	const v = process.env[n]?.trim();
	if (!v) throw new Error(`${n} not set (run under \`snowglobe run --app atmo --\`)`);
	return v;
};
const origin = (u) => new URL(u).origin;
const ATMO = origin(need('OAUTH_PUBLIC_URL'));
const HOST = origin(need('GROUP_HOST_URL'));
const HOST_DID = need('GROUP_HOST_DID');
const PLC = origin(need('PUBLIC_PLC_URL'));
const ALPHA = origin(need('SPACES_PDS_URL'));
const RELAY = origin(need('PUBLIC_RELAY_URLS').split(',')[0]);
const CRON_SECRET = process.env.WALK_CRON_SECRET?.trim() || 'local-network-only';
const ATMO_LOG = process.env.WALK_ATMO_LOG?.trim() || '';
const EVIDENCE = process.env.WALK_EVIDENCE_DIR?.trim() || '';
const ONLY = (process.env.WALK_ONLY ?? '')
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
// atmo.app.<domain>
const DOMAIN = new URL(ATMO).hostname.replace(/^atmo\.app\./, '');
const GROUP_DOMAIN = new URL(HOST).hostname; // groups' handles are <label>.<this>
const GLOBE = DOMAIN.split('.')[0];
const ACCOUNTS_FILE =
	process.env.WALK_ACCOUNTS_ENV?.trim() ||
	path.join(os.homedir(), '.local/share/snowglobe', GLOBE, 'accounts.env');
const accountsEnv = Object.fromEntries(
	fs
		.readFileSync(ACCOUNTS_FILE, 'utf8')
		.split('\n')
		.filter((l) => l.includes('='))
		.map((l) => [
			l.slice(0, l.indexOf('=')),
			l.slice(l.indexOf('=') + 1).replace(/^['"]|['"]$/g, '')
		])
);
const person = (name) => ({
	name,
	handle: accountsEnv[`${name.toUpperCase()}_HANDLE`],
	did: accountsEnv[`${name.toUpperCase()}_DID`],
	password: accountsEnv[`${name.toUpperCase()}_PASSWORD`]
});
const ALICE = person('alice');
const BOB = person('bob');
for (const p of [ALICE, BOB])
	if (!p.handle || !p.password) throw new Error(`no ${p.name} in ${ACCOUNTS_FILE}`);

const RUN = Date.now().toString(36);
const WALK_START = new Date();
const NAME = `Hill walkers ${RUN}`;
const NAME2 = `Dale riders ${RUN}`;
const EVENT = `Ridge walk ${RUN}`;
const RENAMED = `${EVENT} at eight`;

const DECLARATION = 'org.atgrp.declaration';
const EVENTS = 'community.lexicon.calendar.event';

// ---------- log, masked ----------
const secrets = [ALICE.password, BOB.password];
const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]*/g;
const mask = (s) =>
	secrets.reduce((t, x) => t.split(x).join('<masked>'), String(s)).replace(JWT, '<jwt>');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (EVIDENCE) fs.mkdirSync(EVIDENCE, { recursive: true });
const WALK_TXT = EVIDENCE ? path.join(EVIDENCE, 'walk.txt') : '';
if (WALK_TXT) fs.writeFileSync(WALK_TXT, '');
const log = (...a) => {
	const line = mask(a.join(' '));
	console.log(line);
	if (WALK_TXT) fs.appendFileSync(WALK_TXT, `${line}\n`);
};

// ---------- the steps ----------
const defined = [];
/** `needs` are step names that run first (and are run too when only this one is asked for). */
function step(section, name, fn, { needs = [], todo = null } = {}) {
	defined.push({ section, name, fn, needs, todo, n: defined.length + 1 });
}
const stepNamed = (name) => defined.find((s) => s.name === name);

const S = {
	pages: {}, // by who
	groups: {}, // by key: { did, handle, name, ... }
	outside: new Map(), // hosts outside the network the browsers asked for -> { count, example }
	pageErrors: 0,
	har: []
};
let CURRENT = null; // the step running, for check()

function check(label, ok, detail) {
	const entry = { label, ok: Boolean(ok) };
	CURRENT.checks.push(entry);
	log(`     ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
	return Boolean(ok);
}
const note = (...a) => log(`     note: ${a.join(' ')}`);

// ---------- the browser ----------
const browser = await chromium.launch({
	args: [`--host-resolver-rules=MAP *.${DOMAIN} 127.0.0.1`]
});
let contexts = 0;
async function newContext(who) {
	const index = ++contexts;
	const options = { ignoreHTTPSErrors: true };
	if (EVIDENCE) {
		const file = path.join(EVIDENCE, `.har-part-${index}-${who}.har`);
		options.recordHar = { path: file, content: 'omit' };
		S.har.push(file);
	}
	const context = await browser.newContext(options);
	// The console's handle field asks the host for suggestions, which the host asks a typeahead
	// service on the real network. None is on this network, so the field gets no suggestions and the
	// walk sends the handle as typed.
	await context.route('**/xrpc/org.atgrp.internal.searchActors?*', (route) =>
		route.fulfill({ json: { actors: [] } })
	);
	context.on('request', (request) => {
		const host = new URL(request.url()).hostname;
		if (
			host === DOMAIN ||
			host.endsWith(`.${DOMAIN}`) ||
			host === '127.0.0.1' ||
			host === 'localhost'
		)
			return;
		const seen = S.outside.get(host) ?? { count: 0, example: request.url().split('?')[0], by: who };
		seen.count++;
		S.outside.set(host, seen);
	});
	return context;
}
async function pageFor(who) {
	const context = await newContext(who);
	const page = await context.newPage();
	page.on('pageerror', (e) => {
		S.pageErrors++;
		log(`     [${who}] browser error: ${e.message.slice(0, 200)}`);
	});
	page.setDefaultTimeout(30_000);
	S.pages[who] = page;
	if (CURRENT) CURRENT.shot = page;
	return page;
}
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {});
const mainText = async (page) =>
	(await page.locator('main').first().innerText({ timeout: 15_000 })).replace(/\s+/g, ' ');
const status = async (page, url) => (await page.goto(url, { waitUntil: 'networkidle' }))?.status();
const onAtmo = (page) => new URL(page.url()).origin === ATMO;

/** Drives the pages a click led to (PDS sign-in and consent, the group host's console) until
 *  `done(url)`. `onApprove(page)` sees the console's approval page before it is approved. */
async function through(page, who, done, options = {}) {
	// A click can lose a race with the page navigating away on its own: look again, a few times.
	for (let attempt = 1; ; attempt++) {
		try {
			return await throughOnce(page, who, done, options);
		} catch (e) {
			if (attempt >= 4 || /^stuck for/.test(e.message)) throw e;
			await sleep(500);
		}
	}
}
async function throughOnce(page, who, done, { onApprove, stopAt } = {}) {
	for (let i = 0; i < 150; i++) {
		const u = new URL(page.url());
		if (done(u)) return;
		if (stopAt && (await stopAt(page))) return;
		if (u.origin === HOST) {
			// The host's own pages. The recovery key page is only passed, never read.
			if (
				await page
					.locator('#recovery')
					.count()
					.catch(() => 0)
			) {
				await page.click('#continue');
				await page.locator('#recovery').waitFor({ state: 'detached', timeout: 45_000 });
				continue;
			}
			const approve = page.getByRole('button', { name: /^sign it in as/i }).first();
			if (await approve.isVisible().catch(() => false)) {
				if (onApprove) await onApprove(page);
				await approve.click();
				await sleep(1000);
				continue;
			}
			const signIn = page.getByRole('banner').getByRole('button', { name: /^sign in$/i });
			const dialog = page.getByRole('dialog', { name: 'Sign in with your Atmosphere account' });
			if (
				(await signIn.isVisible().catch(() => false)) &&
				(await page
					.getByText(/sign in first/i)
					.count()
					.catch(() => 0))
			) {
				await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
				await signIn.click();
				const handle = dialog.getByRole('combobox', { name: 'Handle' });
				await handle.fill(who.handle);
				await handle.press('Enter');
				await sleep(1500);
				continue;
			}
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
		if (u.origin !== ATMO && (await btn.isVisible().catch(() => false))) {
			await btn.click({ timeout: 10_000 });
			await sleep(800);
			continue;
		}
		await sleep(400);
	}
	throw new Error(`stuck for ${who.name} at ${page.url().split('?')[0]}`);
}

/** A person's own page, signed in to atmo through their PDS. */
async function signInToAtmo(who, key) {
	const page = await pageFor(key ?? who.name);
	await page.goto(ATMO, { waitUntil: 'networkidle', timeout: 90_000 });
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
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
	await through(page, who, (u) => u.origin === ATMO);
	await settle(page);
	return page;
}

/** Links a group from /groups, by what is typed in the field. */
async function startLink(page, typed) {
	await page.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	await page.fill('#group-link', typed);
	await page.getByRole('button', { name: /^link$/i }).click();
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
}

// ---------- the group host and the network, read directly ----------
async function getJson(url, init) {
	const res = await fetch(url, init);
	const text = await res.text();
	let body = null;
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	return { status: res.status, body, text, headers: res.headers };
}
async function repoRecords(did, collection) {
	const { body } = await getJson(
		`${HOST}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: did, collection })}`
	);
	return (body?.records ?? []).map((r) => ({
		rkey: r.uri.split('/').pop(),
		value: r.value,
		uri: r.uri
	}));
}
async function handleOf(did) {
	const { body } = await getJson(`${PLC}/${did}`);
	const aka = (body?.alsoKnownAs ?? []).find((a) => a.startsWith('at://'));
	return aka ? aka.slice('at://'.length) : null;
}
async function until(read, want, tries = 40, every = 500) {
	let last;
	for (let i = 0; i < tries; i++) {
		last = await read();
		if (want(last)) return { ok: true, last };
		await sleep(every);
	}
	return { ok: false, last };
}
/** One ingest cycle, as the built Worker's own scheduled() sends it. */
async function runCron() {
	const r = await fetch(`${ATMO}/api/cron`, {
		method: 'POST',
		headers: { 'X-Cron-Secret': CRON_SECRET, 'content-type': 'application/json' }
	});
	if (!r.ok) throw new Error(`atmo's cron: ${r.status}`);
}

/** The lines of a file after byte `from`: the dev server's log, and the group host's. */
const atmoLogSize = () => (ATMO_LOG && fs.existsSync(ATMO_LOG) ? fs.statSync(ATMO_LOG).size : 0);
function atmoLogSince(from) {
	if (!ATMO_LOG || !fs.existsSync(ATMO_LOG)) return '';
	const buf = fs.readFileSync(ATMO_LOG);
	return buf.subarray(from).toString('utf8');
}
function dockerLogs(container, since) {
	try {
		return execFileSync('docker', ['logs', '--since', since.toISOString(), container], {
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
			maxBuffer: 256 * 1024 * 1024
		});
	} catch (e) {
		return `${e.stdout ?? ''}${e.stderr ?? ''}`;
	}
}
const GH = 'atmogroups-grouphost-gh-1';
const GH_CONSOLE = 'atmogroups-grouphost-gh-console-1';
/** The group host's request lines since `since`: { route, status, at }. */
function hostRequests(since) {
	const out = [];
	for (const line of dockerLogs(GH, since).split('\n')) {
		if (!line.startsWith('{')) continue;
		try {
			const j = JSON.parse(line);
			if (j.fields?.message !== 'request') continue;
			out.push({
				route: j.fields.route,
				status: j.fields.status,
				at: j.timestamp,
				method: j.fields.method
			});
		} catch {
			// not a request line
		}
	}
	return out;
}

// ---------- names that only this machine can resolve ----------
// A group's handle is a name under the network's domain that /etc/hosts does not carry. The browsers
// map every name of the network to this machine (--host-resolver-rules). Node does not, and atmo's
// server fetches https://<handle>/.well-known/atproto-did, so each handle this walk makes is added,
// by exact name, to the marked block of /etc/hosts.
async function resolves(name) {
	try {
		await dns.lookup(name);
		return true;
	} catch {
		return false;
	}
}
const addedNames = [];
async function makeResolvable(name) {
	if (await resolves(name)) return true;
	if (!/^[a-z0-9][a-z0-9.-]*\.local\.snowglobe\.at$/.test(name)) return false;
	try {
		execFileSync(
			'sudo',
			['-n', 'sed', '-i', `/^# <<< test network/i 127.0.0.1 ${name}`, '/etc/hosts'],
			{
				stdio: 'ignore'
			}
		);
		addedNames.push(name);
	} catch {
		return false;
	}
	return resolves(name);
}

// ---------- making groups, as a founder's own PDS vouches for it ----------
async function pdsSession(who) {
	const { status: s, body } = await getJson(`${ALPHA}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: who.handle, password: who.password })
	});
	if (s !== 200) throw new Error(`createSession for ${who.name} answered ${s}`);
	return body.accessJwt;
}
async function serviceAuth(who, lxm) {
	const jwt = await pdsSession(who);
	const q = new URLSearchParams({ aud: HOST_DID, lxm });
	const { status: s, body } = await getJson(
		`${ALPHA}/xrpc/com.atproto.server.getServiceAuth?${q}`,
		{ headers: { authorization: `Bearer ${jwt}` } }
	);
	if (s !== 200) throw new Error(`getServiceAuth answered ${s}`);
	return body.token;
}
/** The host's own createGroup: a public group (the host's default), its declaration written by the
 *  host. `stewards` are DIDs given a role at once. */
async function createGroup(founder, label, displayName, { stewards = [] } = {}) {
	const handle = `${label}.${GROUP_DOMAIN}`;
	const token = await serviceAuth(founder, 'org.atgrp.internal.createGroup');
	const made = await getJson(`${HOST}/xrpc/org.atgrp.internal.createGroup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({
			handle,
			displayName,
			description: `A made-up walking group, run ${RUN}.`,
			joinPolicy: 'approval',
			...(stewards.length ? { stewards: stewards.map((did) => ({ did })) } : {})
		})
	});
	if (made.status !== 200)
		throw new Error(`createGroup answered ${made.status} ${made.text.slice(0, 200)}`);
	await makeResolvable(handle);
	return {
		did: made.body.did,
		meta: made.body.meta,
		members: made.body.members,
		handle,
		name: displayName
	};
}

// ---------- signing in as a group with an app of the walk's own ----------
// A loopback OAuth client, so the walk can change what only an admin can: the meta space's policy,
// and who holds a role. The person approves in the host's console, as for atmo.
const CB_PORT = 39421;
const REDIRECT = `http://127.0.0.1:${CB_PORT}/cb`;
async function signInAsGroup(page, who, group, scope) {
	const app = new OAuthClient({
		metadata: { redirect_uris: [REDIRECT], scope },
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
		target: { type: 'account', identifier: group.did },
		scope
	});
	let cb = null;
	const server = http.createServer((rq, rs) => {
		cb = new URL(rq.url, REDIRECT);
		rs.end('ok');
	});
	await new Promise((r) => server.listen(CB_PORT, '127.0.0.1', r));
	try {
		await page.goto(url.toString(), { waitUntil: 'load', timeout: 60_000 });
		await through(page, who, () => cb !== null);
	} finally {
		await new Promise((r) => server.close(r));
	}
	const { session } = await app.callback(cb.searchParams);
	return session;
}
async function asGroup(session, nsid, init) {
	const res = await session.handle(`/xrpc/${nsid}`, init);
	const text = await res.text();
	let body = {};
	try {
		body = JSON.parse(text);
	} catch {
		// not JSON
	}
	if (!res.ok)
		throw new Error(`${nsid} answered ${res.status} ${body.error ?? ''} ${body.message ?? ''}`);
	return body;
}
const post = (body) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
});
const ADMIN_SCOPE = [
	'atproto',
	'include:org.atgrp.authManageAdmin',
	'include:org.atgrp.authManageMembers'
].join(' ');
/** Sets the meta space's publicRead, keeping the rest of its policy, as the group. */
async function setMetaPublic(session, group, publicRead) {
	const now = await asGroup(
		session,
		`com.atproto.space.getSpace?${new URLSearchParams({ space: group.meta })}`,
		{ method: 'GET' }
	);
	await asGroup(
		session,
		'com.atproto.space.updateSpace',
		post({ space: group.meta, policy: { ...now.policy, publicRead } })
	);
}

// A small picture, made here: a solid-colour PNG.
function png(width, height, [r, g, b]) {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const body = Buffer.concat([Buffer.from(type), data]);
		const out = Buffer.alloc(body.length + 8);
		out.writeUInt32BE(data.length, 0);
		body.copy(out, 4);
		out.writeUInt32BE(crc(body), body.length + 4);
		return out;
	};
	const head = Buffer.alloc(13);
	head.writeUInt32BE(width, 0);
	head.writeUInt32BE(height, 4);
	head.set([8, 2, 0, 0, 0], 8);
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())
	]);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', head),
		chunk('IDAT', zlib.deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

async function editorPublish(page, name, { picture } = {}) {
	const field = page.locator('main [contenteditable=true]').first();
	await field.waitFor({ timeout: 60_000 });
	await field.click();
	await page.keyboard.type(name);
	await page.getByRole('button', { name: /^start date/i }).click();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	if (picture) {
		await page.locator('input[type=file][accept="image/*"]').first().setInputFiles({
			name: 'ridge.png',
			mimeType: 'image/png',
			buffer: picture
		});
		await sleep(800);
		// A crop or confirm dialog may follow a picture.
		const confirm = page
			.getByRole('button', { name: /^(done|apply|save|use|crop|confirm)/i })
			.last();
		if (
			await page
				.getByRole('dialog')
				.isVisible()
				.catch(() => false)
		) {
			if (await confirm.isVisible().catch(() => false)) await confirm.click();
			await sleep(500);
		}
	}
	await page.getByRole('button', { name: /^publish/i }).click();
}

// =====================================================================================
// setup
// =====================================================================================
step('setup', 'network-answers', async () => {
	const health = await getJson(`${HOST}/xrpc/_health`);
	check('the group host answers its health check', health.status === 200, `${health.status}`);
	const described = await getJson(`${HOST}/xrpc/com.atproto.server.describeServer`);
	check(
		"the host's DID is the one atmo is set to (GROUP_HOST_DID)",
		described.body?.did === HOST_DID,
		`${described.body?.did} vs ${HOST_DID}`
	);
	const app = await getJson(`${ATMO}/groups`);
	check("atmo's dev server answers at its public name", app.status === 200, `${app.status}`);
	const alpha = await getJson(`${ALPHA}/xrpc/_health`);
	check("alice's and bob's PDS answers", alpha.status === 200, `${alpha.status}`);
	// atmo's server looks a handle up at https://<handle>/.well-known/atproto-did. This machine's DNS
	// does not answer the network's names, so the two people's handles are added to /etc/hosts too.
	for (const who of [ALICE, BOB])
		check(
			`${who.name}'s handle resolves for atmo's server`,
			await makeResolvable(who.handle),
			who.handle
		);
	// Before anything is written, so the index's place in Jetstream comes before this walk's records.
	await runCron();
	note(`run ${RUN}; the index has had one ingest cycle`);
});

step(
	'setup',
	'alice-makes-groups',
	async () => {
		const g1 = await createGroup(ALICE, `lk${RUN}`, NAME);
		S.groups.g1 = g1;
		check(
			'alice makes a public group at the host, by createGroup',
			g1.did?.startsWith('did:plc:'),
			g1.did
		);
		note(`the group is ${g1.did} (${g1.handle})`);
		const handle = await handleOf(g1.did);
		check('its DID document names its handle', handle === g1.handle, `${handle}`);
		check('its handle resolves for this machine', await resolves(g1.handle), g1.handle);
		const got = await getJson(`${HOST}/xrpc/org.atgrp.internal.getGroup?group=${g1.did}`);
		check(
			'the host answers getGroup for it, signed out, naming its handle',
			got.status === 200 &&
				got.body?.group?.did === g1.did &&
				got.body?.group?.handle === g1.handle,
			`${got.status} ${got.text.slice(0, 160)}`
		);
		const declared = await until(
			() => repoRecords(g1.did, DECLARATION),
			(r) => r.some((x) => x.rkey === 'self'),
			20
		);
		check('the host wrote its declaration in its public repo, as the group is public', declared.ok);
		// For the steps that need a group the walker has a role in, and one it has not: bob is made a
		// steward of the second, and alice, its founder, takes his role away at the host later.
		const g2 = await createGroup(ALICE, `dl${RUN}`, NAME2, { stewards: [BOB.did] });
		S.groups.g2 = g2;
		check(
			'alice makes a second group, with bob as a steward',
			g2.did?.startsWith('did:plc:'),
			g2.did
		);
		note(`the second group is ${g2.did} (${g2.handle})`);
	},
	{ needs: ['network-answers'] }
);

step(
	'setup',
	'people-sign-in',
	async (t) => {
		const alice = await signInToAtmo(ALICE);
		const bob = await signInToAtmo(BOB);
		await pageFor('anon');
		t.shot = alice;
		check(
			'alice and bob sign in to atmo through their own PDS',
			(await alice.getByRole('button', { name: /^log in$/i }).count()) === 0 &&
				(await bob.getByRole('button', { name: /^log in$/i }).count()) === 0
		);
	},
	{ needs: ['network-answers'] }
);

// =====================================================================================
// link: link a group through the host's console, see it, list and unlist it, post events as it
// =====================================================================================
step(
	'link',
	'link-is-offered',
	async (t) => {
		const { alice, anon } = S.pages;
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'signed in, /groups offers to link a group; signed out it does not',
			(await alice.locator('#group-link').count()) === 1 &&
				(await anon.locator('#group-link').count()) === 0
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'link',
	'not-linked-not-listed',
	async (t) => {
		const { alice, anon } = S.pages;
		const url = `${ATMO}/groups/${S.groups.g1.did}`;
		const seen = [await status(alice, url), await status(anon, url)];
		t.shot = anon;
		check(
			"not linked, and not yet in atmo's index, its page is a 404, signed in or out",
			seen.every((s) => s === 404),
			seen.join(' ')
		);
	},
	{ needs: ['link-is-offered', 'alice-makes-groups'] }
);

step(
	'link',
	'alice-links-by-handle',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		const since = new Date(Date.now() - 2000);
		const logAt = atmoLogSize();
		let approval = null;
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				approval = {
					asked:
						(await page
							.locator('pre.scopes')
							.first()
							.textContent()
							.catch(() => '')) ?? '',
					text: await mainText(page),
					// With the rows' detail dialogs, which hold the collections each scope names.
					detail:
						(await page
							.locator('main form')
							.first()
							.textContent()
							.catch(() => '')) ?? ''
				};
				await page.screenshot({ path: shotPath('alice-links-by-handle-approval') }).catch(() => {});
			}
		});
		await settle(alice);
		t.shot = alice;
		S.linkedSince = since;
		const landed = new URL(alice.url());
		check(
			'alice links it by its handle through the console and lands on its page, hers to run',
			landed.pathname === `/groups/${g.did}` &&
				landed.searchParams.get('link') === 'linked' &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			alice.url()
		);
		check(
			'the console asked to sign atmo in as the group, naming it',
			approval !== null && approval.text.includes(g.handle),
			approval?.text.slice(0, 200)
		);
		if (approval) {
			S.approval = approval;
			note(`atmo asked for: ${approval.asked.trim().replace(/\s+/g, ' ')}`);
			// The host keeps or drops each scope whole: an admin's grant keeps all four.
			const asked = approval.asked;
			check(
				'atmo asked for the meta read, the declaration and event repo scopes, and image blobs',
				/space:org\.atgrp\.meta\?authority=self&action=read/.test(asked) &&
					/repo\?collection=org\.atgrp\.declaration|repo:org\.atgrp\.declaration/.test(asked) &&
					/community\.lexicon\.calendar\.event/.test(asked) &&
					/blob\?accept=image|blob:image/.test(asked),
				asked.trim().replace(/\s+/g, ' ')
			);
			const detail = approval.detail.replace(/\s+/g, ' ');
			check(
				"an admin's grant keeps the meta read and the repo writes asked: both are listed as granted, nothing as withheld",
				/Repository/.test(detail) &&
					/Spaces/.test(detail) &&
					/org\.atgrp\.declaration/.test(detail) &&
					/community\.lexicon\.calendar\.event/.test(detail) &&
					!/it would not get/i.test(approval.text),
				detail.slice(0, 500)
			);
			note(
				'the blob scope is not listed on the page; the picture upload in post-event-with-picture shows it was kept'
			);
		}
		const after = atmoLogSince(logAt);
		if (ATMO_LOG)
			check(
				'the token exchange completed: atmo logged the group as linked by alice',
				after.includes(`${g.did} linked by ${ALICE.did}`),
				after.slice(-300)
			);
		else note('no WALK_ATMO_LOG, so atmo\'s own "linked by" line is not checked');
		S.linkedAt = since;
	},
	{ needs: ['not-linked-not-listed'] }
);

step(
	'link',
	'host-fetched-client-metadata',
	async () => {
		// The group host fetches atmo's group client metadata over https to sign the app in. atmo sits
		// behind the network's nginx, whose access log shows each request to its public name.
		// The host keeps a client's metadata for ten minutes, so the fetch may be from an earlier
		// run's link a few minutes back: look back that far, for a request that no browser made.
		const log = dockerLogs('atmogroups-nginx-1', new Date(S.linkedSince.getTime() - 11 * 60_000));
		const lines = log
			.split('\n')
			.filter((l) => l.includes('GET /oauth/group/client-metadata.json'))
			.filter((l) => !l.includes('Mozilla'));
		check(
			"the host fetched atmo's group client metadata (within the ten minutes it keeps it), and it answered 200",
			lines.some((l) => / 200 /.test(l)),
			lines.slice(-3).join(' | ').slice(0, 300) || 'no such request in the nginx log'
		);
		const pars = hostRequests(S.linkedSince).filter((r) => r.route === '/oauth/par');
		check(
			"the host took atmo's pushed authorization request for the group (201 needs the metadata)",
			pars.length > 0 && pars.some((r) => r.status === 201),
			JSON.stringify(pars.map((r) => r.status))
		);
		const meta = await getJson(`${ATMO}/oauth/group/client-metadata.json`);
		check(
			"the metadata is for the group client: its id is its own address, its scope names the group's repo",
			meta.status === 200 &&
				meta.body?.client_id === `${ATMO}/oauth/group/client-metadata.json` &&
				String(meta.body?.scope).includes('org.atgrp.meta'),
			`${meta.status} ${meta.text.slice(0, 200)}`
		);
		const requests = hostRequests(S.linkedSince);
		const tokens = requests.filter((r) => r.route === '/oauth/token');
		check(
			'the host answered the token exchange (200)',
			tokens.some((r) => r.status === 200),
			JSON.stringify(tokens.map((r) => r.status))
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'page-reads-the-host',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		const since = new Date(Date.now() - 1500);
		await sleep(1500);
		const res = await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'the group page shows the display name read from the host, its handle and description',
			(await alice.getByRole('heading', { name: NAME }).count()) === 1 &&
				text.includes(`@${g.handle}`) &&
				text.includes('A made-up walking group'),
			text.slice(0, 200)
		);
		check(
			'the group page is never stored',
			res?.headers()['cache-control'] === 'no-store',
			String(res?.headers()['cache-control'])
		);
		// One linked view: a delegation token, a credential for the meta space, and two signed
		// reads of its records (the about record and the policy), each answered 200 by the host.
		await sleep(1000);
		const requests = hostRequests(since);
		const of = (route) => requests.filter((r) => r.route.endsWith(route));
		const delegation = of('/com.atproto.space.getDelegationToken');
		const credential = of('/com.atproto.space.authorizeSpaceSync');
		const records = of('/com.atproto.space.getRecord');
		note(
			`host saw: getDelegationToken ${delegation.map((r) => r.status)}, authorizeSpaceSync ${credential.map((r) => r.status)}, getRecord ${records.map((r) => r.status)}`
		);
		const all200 = (rs) => rs.length > 0 && rs.every((r) => r.status === 200);
		check(
			'opening the page asked the host for a delegation token, and it answered 200',
			all200(delegation)
		);
		check(
			'...and exchanged it for a space credential (authorizeSpaceSync), 200',
			all200(credential)
		);
		check(
			'...and made two signed getRecord reads of the meta space (about and policy), both 200',
			records.length >= 2 && records.every((r) => r.status === 200),
			JSON.stringify(records.map((r) => r.status))
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'group-shows-under-groups',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		const listRes = await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = alice;
		// Groups linked by an earlier run of the walk are listed too, in the order the store keeps them.
		const items = (await alice.locator('main ul li').allInnerTexts()).map((x) =>
			x.replace(/\s+/g, ' ')
		);
		const mine = items.find((x) => x.includes(g.handle)) ?? '';
		const lastLinked = items.map((x) => x.includes('Linked')).lastIndexOf(true);
		const firstPlain = items.findIndex((x) => !x.includes('Linked'));
		check(
			'/groups lists it for alice, marked Linked, by the name the host gave it, among the linked groups that lead the list',
			mine.includes('Linked') &&
				mine.includes(NAME) &&
				(firstPlain === -1 || firstPlain > lastLinked),
			items.join(' | ').slice(0, 300)
		);
		check('/groups is never stored', listRes?.headers()['cache-control'] === 'no-store');
		const odd = [
			await status(S.pages.anon, `${ATMO}/groups?link=toString`),
			await status(alice, `${ATMO}/groups/${g.did}?link=constructor`)
		];
		check(
			'a made-up ?link= is a page, not a 500',
			odd.every((s) => s === 200),
			odd.join(' ')
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'listed-by-the-host',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.g1;
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'a public group made by createGroup shows as listed: the host wrote its declaration',
			(await alice.getByRole('button', { name: /^remove from the groups list$/i }).count()) === 1 &&
				(await alice.getByRole('button', { name: /^add to the groups list$/i }).count()) === 0
		);
		// One linked view told the index, which does not otherwise hear of the host.
		// atmo reads which groups its host holds once and keeps that for ten minutes (heldAtGroupHost),
		// and a group the host holds counts only if it is in that read: a group made after it waits.
		const began = Date.now();
		// Read as plain requests, not page loads, so a wait of minutes does not fill the browser traffic.
		const seen = () =>
			fetch(`${ATMO}/groups`)
				.then((r) => r.text())
				.then((x) => x.includes(NAME));
		let shown = await until(seen, (x) => x === true, 6, 1000);
		if (!shown.ok) {
			note(
				"not listed yet: atmo's read of the host's groups may be up to ten minutes old; waiting for it"
			);
			shown = await until(seen, (x) => x === true, 66, 10_000);
		}
		note(`listed for a visitor after ${Math.round((Date.now() - began) / 1000)} s`);
		check(
			"after one linked view, the group is in the index's list: signed out, /groups shows it",
			shown.ok
		);
		const listed = await getJson(`${ATMO}/xrpc/rsvp.atmo.declaration.listDeclared?limit=50`);
		check(
			'listDeclared names it',
			listed.status === 200 && listed.text.includes(g.did),
			`${listed.status} ${listed.text.slice(0, 160)}`
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'visitor-browses-it',
	async (t) => {
		const { anon } = S.pages;
		const g = S.groups.g1;
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		await anon.locator(`a[href$="/groups/${g.did}"]`).first().click();
		await anon.waitForURL((u) => u.pathname === `/groups/${g.did}`);
		await settle(anon);
		t.shot = anon;
		const text = await mainText(anon);
		check(
			'a signed-out visitor follows /groups to its page, which names it and offers no controls',
			text.includes(NAME) &&
				(await anon.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
				(await anon.getByRole('button', { name: /unlink|groups list/i }).count()) === 0 &&
				(await anon.getByRole('button', { name: /link this group/i }).count()) === 0,
			text.slice(0, 200)
		);
	},
	{ needs: ['listed-by-the-host'] }
);

step(
	'link',
	'unlist-and-list',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.g1;
		const url = `${ATMO}/groups/${g.did}`;
		await alice.goto(url, { waitUntil: 'networkidle' });
		await alice.getByRole('button', { name: /^remove from the groups list$/i }).click();
		const gone = await until(
			() => repoRecords(g.did, DECLARATION),
			(rs) => rs.length === 0
		);
		await alice.goto(url, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			"alice removes it from the list: the declaration leaves the group's repo and the page offers to add it",
			gone.ok &&
				(await alice.getByRole('button', { name: /^add to the groups list$/i }).count()) === 1
		);
		const hidden = await until(
			async () => {
				const s = await status(anon, url);
				await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
				return { s, listed: (await mainText(anon)).includes(NAME) };
			},
			(x) => x.s === 404 && !x.listed,
			10
		);
		check(
			'unlisted, the signed-out groups list no longer shows it, and its page is a 404 for a visitor',
			hidden.ok,
			JSON.stringify(hidden.last)
		);
		await alice.getByRole('button', { name: /^add to the groups list$/i }).click();
		const back = await until(
			() => repoRecords(g.did, DECLARATION),
			(rs) => rs.some((r) => r.rkey === 'self')
		);
		await alice.goto(url, { waitUntil: 'networkidle' });
		check(
			'alice adds it again: the declaration is back in its repo and the page offers to remove it',
			back.ok &&
				(await alice.getByRole('button', { name: /^remove from the groups list$/i }).count()) === 1
		);
		const shown = await until(
			async () => {
				const s = await status(anon, url);
				await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
				return { s, listed: (await mainText(anon)).includes(NAME) };
			},
			(x) => x.s === 200 && x.listed,
			10
		);
		check(
			'listed again, a visitor sees it in /groups and on its page',
			shown.ok,
			JSON.stringify(shown.last)
		);
	},
	{ needs: ['listed-by-the-host'] }
);

step(
	'link',
	'post-event-with-picture',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		await alice.goto(`${ATMO}/groups/${g.did}/events/new`, { waitUntil: 'networkidle' });
		await editorPublish(alice, EVENT, { picture: png(96, 64, [40, 120, 80]) });
		await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 60_000 });
		await settle(alice);
		t.shot = alice;
		const rkey = new URL(alice.url()).pathname.split('/').pop();
		S.rkey = rkey;
		const posted = await until(
			() => repoRecords(g.did, EVENTS),
			(rs) => rs.some((r) => r.rkey === rkey && r.value?.name === EVENT),
			40
		);
		check(
			"alice posts an event as the group, and it lands in the group's repo",
			new URL(alice.url()).pathname === `/p/${g.did}/e/${rkey}` && posted.ok,
			alice.url()
		);
		const record = posted.last?.find((r) => r.rkey === rkey)?.value;
		const blobs = JSON.stringify(record ?? {}).match(/"\$type":"blob"/g) ?? [];
		check(
			'the record carries the picture as a blob the group host holds',
			blobs.length >= 1,
			JSON.stringify(record).slice(0, 300)
		);
		const cid = JSON.stringify(record ?? {}).match(/"\$link":"([^"]+)"/)?.[1];
		if (cid) {
			const blob = await fetch(
				`${HOST}/xrpc/com.atproto.sync.getBlob?${new URLSearchParams({ did: g.did, cid })}`
			);
			check(
				'the host serves that blob as an image',
				blob.status === 200 && (blob.headers.get('content-type') ?? '').startsWith('image/'),
				`${blob.status} ${blob.headers.get('content-type')}`
			);
		}
		const text = await mainText(alice);
		check(
			'the event page shows the group as its host',
			text.includes(NAME) || text.includes(g.handle),
			text.slice(0, 300)
		);
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		check(
			'the group page lists it, with an Edit link for alice',
			(await mainText(alice)).includes(EVENT) &&
				(await alice.locator(`a[href$="/groups/${g.did}/events/${rkey}/edit"]`).count()) === 1
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'edit-event',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		await alice.goto(`${ATMO}/groups/${g.did}/events/${S.rkey}/edit`, { waitUntil: 'networkidle' });
		const field = alice.locator('main [contenteditable=true]').first();
		await field.waitFor({ timeout: 60_000 });
		await field.click();
		await alice.keyboard.press('End');
		await alice.keyboard.type(' at eight');
		await alice.getByRole('button', { name: /^save changes$/i }).click();
		await alice.waitForURL((u) => !u.pathname.endsWith('/edit'), { timeout: 60_000 });
		t.shot = alice;
		const edited = await until(
			() => repoRecords(g.did, EVENTS),
			(rs) => rs.some((r) => r.rkey === S.rkey && r.value?.name === RENAMED)
		);
		check(
			"alice edits it, and the group's repo holds the new name",
			edited.ok,
			JSON.stringify(edited.last?.map((r) => r.value?.name))
		);
		const stillPicture = JSON.stringify(
			edited.last?.find((r) => r.rkey === S.rkey)?.value ?? {}
		).includes('"$type":"blob"');
		check('the edited record keeps its picture', stillPicture);
	},
	{ needs: ['post-event-with-picture'] }
);

step(
	'link',
	'visitor-sees-the-event',
	async (t) => {
		const { anon } = S.pages;
		const g = S.groups.g1;
		const shown = await until(
			async () => {
				await anon.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
				return (await mainText(anon)).includes(RENAMED);
			},
			(x) => x,
			10
		);
		t.shot = anon;
		check('signed out, the group page shows the event, under its new name', shown.ok);
	},
	{ needs: ['edit-event'] }
);

step(
	'link',
	'bob-cannot-link-it',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.g1;
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		const offered = await bob.getByRole('button', { name: /^link this group$/i }).count();
		await bob.getByRole('button', { name: /^link this group$/i }).click();
		await bob.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		let noRole = false;
		await through(bob, BOB, () => noRole, {
			stopAt: async (page) => {
				noRole =
					new URL(page.url()).origin === HOST &&
					(await page.getByText(/don.t have a role in this group/i).count()) > 0;
				return noRole;
			}
		});
		t.shot = bob;
		const text = await mainText(bob);
		check(
			'bob, with no role, is offered the link, and the host says he has no role in this group',
			offered === 1 &&
				noRole &&
				!(await bob.getByRole('button', { name: /^sign it in as/i }).count()),
			`offered ${offered}; ${text.slice(0, 200)}`
		);
		await bob.getByRole('button', { name: /^decline$/i }).click();
		await bob.waitForURL((u) => u.origin === ATMO, { timeout: 30_000 });
		await settle(bob);
		check(
			'declining at the host sends him back to atmo, which says the group was not linked',
			new URL(bob.url()).searchParams.get('link') === 'failed' &&
				(await mainText(bob)).includes('The group was not linked'),
			bob.url()
		);
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		const newPage = await status(bob, `${ATMO}/groups/${g.did}/events/new`);
		const editPage = await status(bob, `${ATMO}/groups/${g.did}/events/${S.rkey}/edit`);
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		check(
			"no link is kept for bob: he sees the visitor's page, with no controls, and the editor is a 404",
			(await bob.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
				(await bob.getByRole('button', { name: /^unlink$/i }).count()) === 0 &&
				(await mainText(bob)).includes(NAME) &&
				newPage === 404 &&
				editPage === 404,
			`new ${newPage}, edit ${editPage}`
		);
	},
	{ needs: ['edit-event'] }
);

step(
	'link',
	'link-follows-alice',
	async (t) => {
		const fresh = await signInToAtmo(ALICE, 'alice-fresh');
		t.shot = fresh;
		await fresh.goto(`${ATMO}/groups/${S.groups.g1.did}`, { waitUntil: 'networkidle' });
		check(
			'in a fresh browser, the link follows alice',
			(await fresh.getByRole('link', { name: /^post an event$/i }).count()) === 1
		);
	},
	{ needs: ['edit-event'] }
);

step(
	'link',
	'delete-event',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		await alice.goto(`${ATMO}/groups/${g.did}/events/${S.rkey}/edit`, { waitUntil: 'networkidle' });
		await alice.getByRole('button', { name: /^delete event$/i }).click();
		await alice.getByRole('button', { name: /^delete$/i }).click();
		await alice.waitForURL((u) => u.pathname === `/groups/${g.did}`, { timeout: 60_000 });
		t.shot = alice;
		const deleted = await until(
			() => repoRecords(g.did, EVENTS),
			(rs) => !rs.some((r) => r.rkey === S.rkey)
		);
		check("alice deletes the event: it leaves the group's repo", deleted.ok);
		await settle(alice);
		check('...and the group page no longer lists it', !(await mainText(alice)).includes(EVENT));
	},
	{ needs: ['edit-event'] }
);

// ---------- the group made private, and its link broken, at the host ----------
step(
	'private',
	'private-at-host',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.g1;
		const since = new Date();
		const page = await pageFor('alice-script');
		const session = await signInAsGroup(page, ALICE, g, ADMIN_SCOPE);
		S.adminSession = session;
		note(`the walk's own app is signed in as the group, as ${session.did}`);
		await setMetaPublic(session, g, false);
		const withdrawn = await until(
			() => repoRecords(g.did, DECLARATION),
			(rs) => rs.length === 0,
			20
		);
		check(
			'made private at the host (updateSpace as its admin), the host removes its declaration',
			withdrawn.ok
		);
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'the page shows the Private badge, and says only a public group can be on the groups list',
			text.includes('Private') && /only a public group can be on the groups list/i.test(text),
			text.slice(0, 250)
		);
		check(
			'...and offers neither to list it nor to remove it from the list',
			(await alice.getByRole('button', { name: /groups list/i }).count()) === 0
		);
		const gone = await until(
			async () => {
				await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
				return (await mainText(anon)).includes(NAME);
			},
			(x) => x === false,
			15
		);
		check('a signed-out visitor no longer finds it in /groups', gone.ok);
		check(
			'...and its page is a 404 for a visitor',
			(await status(anon, `${ATMO}/groups/${g.did}`)) === 404
		);
		note(`host requests since: ${hostRequests(since).length}`);
	},
	{ needs: ['delete-event', 'link-follows-alice', 'bob-cannot-link-it', 'unlist-and-list'] }
);

step(
	'private',
	'private-group-cannot-be-listed',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		// The page offers no way to list it, so ask for the listing as the page's own code does.
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const result = await alice.evaluate(async (did) => {
			const mod = await import('/src/lib/groups/group.remote.ts');
			try {
				await mod.setGroupListed({ groupDid: did, listed: true });
				return { ok: true };
			} catch (e) {
				return {
					ok: false,
					status: e?.status,
					message: e?.body?.message ?? String(e?.message ?? e)
				};
			}
		}, g.did);
		note(`listing a private group answered: ${JSON.stringify(result)}`);
		check(
			'asking to list the private group is refused with the reason: only a public group can be listed',
			result.ok === false &&
				result.status === 409 &&
				/only a public group can be listed/i.test(result.message ?? ''),
			JSON.stringify(result)
		);
		check(
			"...and the group's repo still holds no declaration",
			(await repoRecords(g.did, DECLARATION)).length === 0
		);
	},
	{ needs: ['private-at-host'] }
);

step(
	'private',
	'public-again-at-host',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.g1;
		await setMetaPublic(S.adminSession, g, true);
		const back = await until(
			() => repoRecords(g.did, DECLARATION),
			(rs) => rs.some((r) => r.rkey === 'self'),
			20
		);
		check('made public again at the host, it writes the declaration again', back.ok);
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'the page shows it as listed, without the Private badge',
			(await alice.getByRole('button', { name: /^remove from the groups list$/i }).count()) === 1 &&
				!(await mainText(alice)).includes('Private')
		);
		const shown = await until(
			async () => {
				await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
				return (await mainText(anon)).includes(NAME);
			},
			(x) => x,
			15
		);
		check('a signed-out visitor finds it in /groups again', shown.ok);
	},
	{ needs: ['private-at-host'] }
);

step(
	'private',
	'bob-links-the-second-group',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.g2;
		await startLink(bob, g.handle);
		await through(bob, BOB, (u) => u.origin === ATMO);
		await settle(bob);
		t.shot = bob;
		check(
			'bob, a steward of the second group, links it through the console',
			new URL(bob.url()).pathname === `/groups/${g.did}` &&
				new URL(bob.url()).searchParams.get('link') === 'linked' &&
				(await bob.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			bob.url()
		);
		check(
			'...and the page shows the name the host gave it',
			(await bob.getByRole('heading', { name: NAME2 }).count()) === 1
		);
	},
	{ needs: ['people-sign-in', 'alice-makes-groups'] }
);

step(
	'private',
	'roles-removed-ends-the-link',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.g2;
		// Bob's link was approved by his roles: take them away at the host, as its founder.
		const page = S.pages['alice-script'] ?? (await pageFor('alice-script'));
		const session = await signInAsGroup(page, ALICE, g, ADMIN_SCOPE);
		await asGroup(
			session,
			'com.atproto.space.deleteRecord',
			post({ space: g.members, repo: g.did, collection: 'org.atgrp.membership', rkey: BOB.did })
		);
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = bob;
		const text = await mainText(bob);
		check(
			"with bob's roles removed at the host, his page is the visitor's: no controls, but still the group",
			(await bob.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
				(await bob.getByRole('button', { name: /groups list/i }).count()) === 0 &&
				text.includes(NAME2),
			text.slice(0, 250)
		);
		note(`bob's page now reads: ${text.slice(0, 300)}`);
		// An ejected member's grants are ended by the host, so atmo's session for him is revoked and the
		// page says so ("Link again"), as it does for any revoked link.
		check(
			'...and, the host having ended his grant with his membership, it offers "Link again"',
			(await bob.getByRole('button', { name: /^link again$/i }).count()) === 1
		);
		await bob.getByRole('button', { name: /^link again$/i }).click();
		await bob.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		let noRole = false;
		await through(bob, BOB, () => noRole, {
			stopAt: async (page) => {
				noRole =
					new URL(page.url()).origin === HOST &&
					(await page.getByText(/don.t have a role in this group/i).count()) > 0;
				return noRole;
			}
		});
		check('linking again, the host says he has no role in the group', noRole);
		await bob.getByRole('button', { name: /^decline$/i }).click();
		await bob.waitForURL((u) => u.origin === ATMO, { timeout: 30_000 });
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		const editor = await status(bob, `${ATMO}/groups/${g.did}/events/new`);
		check('...and the editor is a 404 for him', editor === 404, String(editor));
		await bob.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
	},
	{ needs: ['bob-links-the-second-group'] }
);

step(
	'private',
	'revoke-at-host-shows-link-again',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		// The grant atmo holds shows on the group's console page for apps; revoke it there.
		await alice.goto(`${HOST}/g/${g.handle}/settings/apps`, { waitUntil: 'networkidle' });
		await alice.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
		t.shot = alice;
		const revoke = alice.getByRole('button', { name: /^revoke .*atmo\.app.*access$/i });
		const before = await revoke.count();
		check('the console lists atmo as an app acting as the group', before >= 1, `${before} apps`);
		await revoke.first().click();
		await alice
			.getByRole('dialog', { name: /revoke this app/i })
			.filter({ visible: true })
			.getByRole('button', { name: 'Revoke', exact: true })
			.click();
		await until(
			async () => revoke.count(),
			(n) => n < before,
			20
		);
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'with the grant revoked at the host, the page offers "Link again" and says the link stopped working',
			(await alice.getByRole('button', { name: /^link again$/i }).count()) === 1 &&
				/stopped working/i.test(text) &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 0,
			text.slice(0, 250)
		);
		// Link again, as the page invites.
		await alice.getByRole('button', { name: /^link again$/i }).click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		check(
			'linking again works: she is back on the page with its controls',
			new URL(alice.url()).searchParams.get('link') === 'linked' &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			alice.url()
		);
	},
	{ needs: ['alice-links-by-handle'] }
);

step(
	'link',
	'unlink-revokes-at-host',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		const appsPage = `${HOST}/g/${g.handle}/settings/apps`;
		await alice.goto(appsPage, { waitUntil: 'networkidle' });
		await alice.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
		const revoke = alice.getByRole('button', { name: /^revoke .*atmo\.app.*access$/i });
		const before = await revoke.count();
		await alice.goto(`${ATMO}/groups/${g.did}`, { waitUntil: 'networkidle' });
		await alice.getByRole('button', { name: /^unlink$/i }).click();
		await alice.waitForURL((u) => u.pathname === '/groups', { timeout: 30_000 });
		await settle(alice);
		t.shot = alice;
		const items = (await alice.locator('main ul li').allInnerTexts()).map((x) =>
			x.replace(/\s+/g, ' ')
		);
		const mine = items.find((x) => x.includes(g.handle));
		check(
			'alice unlinks it: it is still on the public list, but no longer marked Linked for her',
			mine !== undefined && mine.includes(NAME) && !mine.includes('Linked'),
			mine ?? items.join(' | ').slice(0, 300)
		);
		await alice.goto(appsPage, { waitUntil: 'networkidle' });
		await alice.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
		const after = await until(
			async () => {
				await alice.reload({ waitUntil: 'networkidle' });
				return revoke.count();
			},
			(n) => n < before,
			10
		);
		check(
			"the host no longer lists atmo among the group's apps: the session was revoked there",
			before >= 1 && after.ok,
			`${before} before, ${after.last} after`
		);
		const visitor = await status(alice, `${ATMO}/groups/${g.did}/events/new`);
		check('...and the editor is a 404 for her again', visitor === 404, String(visitor));
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	},
	{ needs: ['revoke-at-host-shows-link-again'] }
);

// =====================================================================================
// flags: what atmo answers with groups on (the off state needs a server started without the host)
// =====================================================================================
step(
	'flags',
	'index-endpoints-answer',
	async () => {
		const g = S.groups.g1;
		const anon = async (method, target, opts = {}) => {
			const r = await fetch(`${ATMO}${target}`, { method, redirect: 'manual', ...opts });
			return { status: r.status, location: r.headers.get('location'), text: await r.text() };
		};
		const unknown = await anon('GET', '/xrpc/rsvp.atmo.no.suchMethod');
		const list = await anon('GET', '/xrpc/rsvp.atmo.declaration.listDeclared?limit=5');
		const one = await anon(
			'GET',
			`/xrpc/rsvp.atmo.declaration.getRecord?uri=at://${g.did}/${DECLARATION}/self`
		);
		const many = await anon('GET', '/xrpc/rsvp.atmo.declaration.listRecords?limit=5');
		check(
			'an unknown method is a 404 (the comparison)',
			unknown.status === 404,
			String(unknown.status)
		);
		check(
			'listDeclared answers (200), and not as an unknown method does',
			list.status === 200 && list.text !== unknown.text,
			`${list.status}`
		);
		check(
			'the declaration index answers getRecord for the group (200) and names it',
			one.status === 200 && one.text.includes(g.did),
			`${one.status} ${one.text.slice(0, 120)}`
		);
		check(
			'the declaration index answers listRecords (200), not as an unknown method',
			many.status === 200 && many.text !== unknown.text,
			String(many.status)
		);
		const page = await anon('GET', `/groups/${g.did}`);
		check(
			'a group page is served to a signed-out visitor',
			page.status === 200,
			String(page.status)
		);
		const madeUp = await anon('GET', '/groups/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa');
		check('a made-up group is a 404 for a visitor', madeUp.status === 404, String(madeUp.status));
		const cb = await anon('GET', '/oauth/group/callback');
		check(
			'the group callback without a state sends the browser to /groups?link=failed',
			cb.status === 303 && String(cb.location).includes('/groups?link=failed'),
			`${cb.status} ${cb.location}`
		);
		const link = await anon('POST', '/oauth/group/link', {
			headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ATMO },
			body: `group=${g.did}`
		});
		check(
			'signed out, linking sends the browser to /login',
			link.status === 303 && String(link.location).includes('/login'),
			`${link.status} ${link.location}`
		);
		const meta = await anon('GET', '/oauth-client-metadata.json');
		const scopes = String(JSON.parse(meta.text || '{}').scope ?? '').split(' ');
		check(
			"atmo's own client metadata does not ask for the group's scopes (a person's session is never a group's)",
			meta.status === 200 && !scopes.some((s) => s.includes('org.atgrp'))
		);
	},
	{ needs: ['listed-by-the-host'] }
);

step('flags', 'off-state', async () => {}, {
	todo: 'the groups-off state needs atmo started without GROUP_HOST_URL, which this run does not restart; check it with a second dev server on another port'
});

// ---------- not yet done by script ----------
step('private', 'todo-lowered-role-gives-visitor-page', async () => {}, {
	todo: 'the visitor page without "Link again" (a role lowered, not removed) needs a role whose read of the meta space the host refuses; by default members read it, so lowering to member leaves the link working. Needs a policy that withholds the meta read, which the host does not allow for members'
});
step('link', 'todo-narrowed-scope-for-a-member', async () => {}, {
	todo: 'needs a person who holds a role without write rights, which comes with the join and roster sections (requestJoin and admit); until then the console grant is only seen for an admin'
});
step('link', 'todo-event-in-index-from-jetstream', async () => {}, {
	todo: 'whether atmo ingests a group host event from Jetstream alone depends on the relay following the group host (requestCrawl), which the network does at its own pace; atmo is told of writes through notifyOfUpdate instead'
});

// =====================================================================================
// the end
// =====================================================================================
step('wrap', 'no-browser-errors', async () => {
	check('no page errors in any browser', S.pageErrors === 0, String(S.pageErrors));
});

// ---------- running ----------
const shotPath = (slug) =>
	EVIDENCE
		? path.join(EVIDENCE, `${String(CURRENT?.n ?? 0).padStart(2, '0')}-${slug}.png`)
		: os.devNull;

function selected() {
	const wanted = new Set();
	const add = (s) => {
		if (wanted.has(s)) return;
		wanted.add(s);
		for (const need of s.needs) add(stepNamed(need));
	};
	for (const s of defined) {
		if (!ONLY.length || ONLY.includes(s.section) || ONLY.includes(s.name) || s.section === 'wrap')
			add(s);
	}
	return defined.filter((s) => wanted.has(s));
}

const results = [];
log(`# atmo groups walk, run ${RUN}, ${WALK_START.toISOString()}`);
log(`# atmo ${ATMO}, group host ${HOST}, accounts ${ALICE.handle} and ${BOB.handle}`);
const plan = selected();
for (const s of plan) {
	const r = { step: s, state: 'pass', checks: [], n: s.n };
	results.push(r);
	CURRENT = r;
	const label = `[${String(s.n).padStart(2, '0')}] ${s.section}/${s.name}`;
	if (s.todo) {
		r.state = 'skip';
		log(`${label}\n     SKIP todo: ${s.todo}`);
		continue;
	}
	const blocker = s.needs
		.map((n) => results.find((x) => x.step.name === n))
		.find((x) => !x || x.state !== 'pass');
	if (blocker) {
		r.state = 'blocked';
		log(`${label}\n     BLOCKED: ${blocker.step.name} did not pass`);
		continue;
	}
	log(label);
	r.shot = null;
	try {
		await s.fn(r);
	} catch (e) {
		r.state = 'fail';
		const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
		r.error = msg;
		log(`     FAIL threw: ${msg}`);
	}
	if (r.checks.some((c) => !c.ok)) r.state = 'fail';
	if (!r.checks.length && r.state === 'pass' && !s.todo) {
		r.state = 'fail';
		log('     FAIL the step checked nothing');
	}
	if (EVIDENCE) {
		const page = r.shot ?? S.pages.alice;
		await page?.screenshot({ path: shotPath(s.name), fullPage: true }).catch(() => {});
	}
	log(`     => ${r.state.toUpperCase()}`);
}

// ---------- evidence at the end ----------
const outside = [...S.outside.entries()];
log('');
log(`outside hosts the browsers asked for: ${outside.length ? '' : 'none'}`);
for (const [host, v] of outside)
	log(`  ${host} (${v.count} requests, first from ${v.by}): ${v.example}`);
if (addedNames.length) log(`names added to /etc/hosts: ${addedNames.join(' ')}`);
if (ATMO_LOG && fs.existsSync(ATMO_LOG)) {
	const hosts = new Set(
		[...fs.readFileSync(ATMO_LOG, 'utf8').matchAll(/https?:\/\/([a-z0-9.-]+)/gi)]
			.map((m) => m[1].toLowerCase())
			.filter(
				(h) => !(h === DOMAIN || h.endsWith(`.${DOMAIN}`)) && h !== 'localhost' && h !== '127.0.0.1'
			)
	);
	log(
		`outside hosts named in atmo's dev server log: ${hosts.size ? [...hosts].join(' ') : 'none'}`
	);
}

// Close every context so each HAR is written, then merge them and strip what must not stay.
for (const context of browser.contexts()) await context.close().catch(() => {});
await browser.close();
if (EVIDENCE) {
	const entries = [];
	let meta = null;
	for (const file of S.har) {
		if (!fs.existsSync(file)) continue;
		const har = JSON.parse(fs.readFileSync(file, 'utf8'));
		meta ??= har.log;
		entries.push(...(har.log.entries ?? []));
		fs.rmSync(file);
	}
	entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime));
	const redact = ['authorization', 'cookie', 'set-cookie', 'dpop'];
	for (const e of entries) {
		for (const part of [e.request, e.response]) {
			for (const h of part.headers ?? [])
				if (redact.includes(h.name.toLowerCase())) h.value = '<redacted>';
			if (part.cookies) part.cookies = part.cookies.map((c) => ({ ...c, value: '<redacted>' }));
		}
		const body = e.request.postData;
		if (body) {
			const text = JSON.stringify(body);
			if (secrets.some((p) => text.includes(p)) || /password|token|secret/i.test(text)) {
				e.request.postData = { mimeType: body.mimeType, text: '<body stripped>' };
			}
		}
		const content = e.response.content;
		if (content?.text && JWT.test(content.text)) content.text = content.text.replace(JWT, '<jwt>');
		JWT.lastIndex = 0;
	}
	fs.writeFileSync(
		path.join(EVIDENCE, 'walk.har'),
		JSON.stringify({
			log: { ...(meta ?? { version: '1.2', creator: { name: 'walk', version: '1' } }), entries }
		})
	);
	if (ATMO_LOG && fs.existsSync(ATMO_LOG))
		fs.copyFileSync(ATMO_LOG, path.join(EVIDENCE, 'atmo-dev.log'));
	for (const [container, file] of [
		[GH, 'group-host.log'],
		[GH_CONSOLE, 'group-host-console.log']
	]) {
		fs.writeFileSync(path.join(EVIDENCE, file), mask(dockerLogs(container, WALK_START)));
	}
}

// ---------- the result ----------
const count = (state) => results.filter((r) => r.state === state).length;
const ran = results.length - count('skip');
log('');
for (const r of results) {
	const flag = { pass: 'pass', fail: 'FAIL', blocked: 'BLOCKED', skip: 'skip' }[r.state];
	log(
		`  ${String(r.n).padStart(2, '0')} ${flag.padEnd(7)} ${r.step.section}/${r.step.name}${r.error ? `  (${r.error})` : ''}`
	);
}
const line = `${count('pass')} of ${ran} steps passed${count('fail') ? `, ${count('fail')} failed` : ''}${count('blocked') ? `, ${count('blocked')} blocked` : ''}${count('skip') ? ` (${count('skip')} skipped)` : ''}`;
log(line);
process.exit(count('fail') + count('blocked') === 0 ? 0 : 1);

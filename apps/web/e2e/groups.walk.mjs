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
// This build holds back making a group from the app, a group's settings page and its members page
// (apps/web/src/lib/groups/build.ts). One group is made at the console's own /new page and linked;
// members are admitted at the host by script; the old create and roster steps stay, skipped as
// "held back in this build", and their addresses are checked to answer as unknown ones do.
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
//   WALK_OLDER_LINK     the DID of a group alice linked on an earlier build, for "Approve again"
//   WALK_EVENT_INDEX_TEST  set on a dev server whose scheduled job has not run since it started:
//                       the groups list's event index is dropped from its database first, to see
//                       the list answer without it and the next ingest cycle build it
//   WALK_ATMO_STATE_DIR the dev server's local state folder (apps/web/<its LOCAL_STATE_DIR>), when it
//                       is not this tree's .wrangler/snowglobe-groups: its database is read there
//   WALK_UNIT           the part of the feature the dev server's build has, when it is one of the
//                       stacked parts on its own: link-group (link, list, browse, post as the group),
//                       join (and asking to join, leaving, "Your groups"), or members-only-events
//                       (the default: the whole feature). The steps of later parts are skipped as
//                       "not in this unit", and checks are added that nothing of them shows
//   WALK_GROUPS_OFF_URL with WALK_UNIT, the address of a dev server of the same build started without
//                       GROUP_HOST_URL (groups off), to compare a person's client metadata with
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
// `suffix` is the PDS's part of the key in accounts.env for the accounts that are not on alpha.
const person = (name, suffix = '', pds = ALPHA) => ({
	name,
	pds,
	handle: accountsEnv[`${name.toUpperCase()}${suffix}_HANDLE`],
	did: accountsEnv[`${name.toUpperCase()}${suffix}_DID`],
	password: accountsEnv[`${name.toUpperCase()}${suffix}_PASSWORD`]
});
const ALICE = person('alice');
const BOB = person('bob');
const MALLORY = person('mallory');
// dana is on the other PDS with spaces, carol on the release without them.
const DANA = person('dana', '_BETA', `https://beta.${DOMAIN}`);
const CAROL = person('carol', '_REGULAR', `https://regular.${DOMAIN}`);
for (const p of [ALICE, BOB, MALLORY, DANA, CAROL])
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
const secrets = [ALICE, BOB, MALLORY, DANA, CAROL].map((p) => p.password);
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
	consoleCrashes: 0,
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
const HAR_KEEPS =
	/^(?!https:\/\/[^/]+\/(@fs|@vite|@id|node_modules|src|\.svelte-kit|_app\/immutable)\/)/;
async function newContext(who) {
	const index = ++contexts;
	const options = { ignoreHTTPSErrors: true };
	if (EVIDENCE) {
		const file = path.join(EVIDENCE, `.har-part-${index}-${who}.har`);
		// Without bodies, and without the dev server's modules or the console's built assets: one page
		// load of the dev server asks for hundreds of them, which made each HAR tens of megabytes.
		options.recordHar = { path: file, content: 'omit', urlFilter: HAR_KEEPS };
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
		if (new URL(page.url()).origin === HOST) S.consoleCrashes++;
		log(`     [${who}] browser error: ${e.message.slice(0, 200)}`);
	});
	// Refusals and failures the pages ran into, for the log: only the host's and atmo's own.
	let refused = 0;
	page.on('response', (r) => {
		const o = new URL(r.url()).origin;
		if (r.status() >= 500 && (o === HOST || o === ATMO) && refused++ < 12)
			log(`     [${who}] ${r.status()} ${r.request().method()} ${r.url().split('?')[0]}`);
	});
	let said = 0;
	page.on('console', (m) => {
		if (m.type() === 'error' && said++ < 8 && new URL(page.url()).origin !== ATMO)
			log(`     [${who}] console error: ${m.text().split('\n')[0].slice(0, 200)}`);
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
async function throughOnce(page, who, done, { onApprove, onConsent, stopAt } = {}) {
	return await throughLoop(page, who, done, { onApprove, onConsent, stopAt });
}
async function throughLoop(page, who, done, { onApprove, onConsent, stopAt }) {
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
			if (
				u.pathname === '/authorize' &&
				(await page
					.getByText(/something went wrong/i)
					.count()
					.catch(() => 0))
			) {
				S.consoleCrashes++;
				throw new Error(
					'stuck for ' + who.name + ": the console's approval page shows 'Something went wrong'"
				);
			}
			const approve = page.getByRole('button', { name: /^sign it in as/i }).first();
			if (await approve.isVisible().catch(() => false)) {
				// The console's script runs after its page is drawn: see whether the page survives it.
				await sleep(2000);
				if (
					await page
						.getByText(/something went wrong/i)
						.count()
						.catch(() => 0)
				)
					continue;
				if (onApprove) await onApprove(page);
				await approve.click();
				await sleep(1000);
				continue;
			}
			const back = page.getByRole('link', { name: /go back to the app/i });
			if (await back.isVisible().catch(() => false)) {
				await back.click();
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
			if (onConsent) await onConsent(page);
			await btn.click({ timeout: 10_000 });
			await sleep(800);
			continue;
		}
		await sleep(400);
	}
	if (EVIDENCE)
		fs.writeFileSync(
			path.join(EVIDENCE, `stuck-${who.name}.html`),
			mask(await page.content().catch(() => ''))
		);
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
	const { status: s, body } = await getJson(`${who.pds}/xrpc/com.atproto.server.createSession`, {
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
		`${who.pds}/xrpc/com.atproto.server.getServiceAuth?${q}`,
		{ headers: { authorization: `Bearer ${jwt}` } }
	);
	if (s !== 200) throw new Error(`getServiceAuth answered ${s}`);
	return body.token;
}
/** The host's own createGroup: a public group (the host's default), its declaration written by the
 *  host. `stewards` are DIDs given a role at once. */
async function createGroup(
	founder,
	label,
	displayName,
	{ stewards = [], joinPolicy = 'approval', publicRead = true } = {}
) {
	const handle = `${label}.${GROUP_DOMAIN}`;
	const token = await serviceAuth(founder, 'org.atgrp.internal.createGroup');
	const made = await getJson(`${HOST}/xrpc/org.atgrp.internal.createGroup`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify({
			handle,
			displayName,
			description: `A made-up walking group, run ${RUN}.`,
			joinPolicy,
			metaPublicRead: publicRead,
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

async function editorPublish(page, name, { picture, placement = 'everyone' } = {}) {
	// A group's new-event page asks who may see the event first, and draws the editor only once that
	// is chosen; other editors have no such choice. Wait for whichever the page draws.
	const choice = page.getByRole('radio', {
		name: placement === 'members' ? /^members only/i : /^everyone/i
	});
	const field = page.locator('main [contenteditable=true]').first();
	await choice.or(field).first().waitFor({ timeout: 60_000 });
	if (await choice.isVisible().catch(() => false)) await choice.check();
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

// ---------- scripted acts at the group host ----------
const spacesOf = (did) => ({
	meta: `at:space/${did}/org.atgrp.meta/self`,
	members: `at:space/${did}/org.atgrp.members/self`
});
/** A call to one of the host's methods, as `who`'s own PDS vouches for it (service auth). */
async function hostCall(who, nsid, body) {
	const token = await serviceAuth(who, nsid);
	return getJson(`${HOST}/xrpc/${nsid}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
		body: JSON.stringify(body)
	});
}
const adminSessions = new Map();
/** A session as the group for `who` (an admin of it), approved once at the console. */
async function adminFor(group, who = ALICE) {
	const key = `${group.did}/${who.name}`;
	if (!adminSessions.has(key)) {
		const page = S.pages[`${who.name}-script`] ?? (await pageFor(`${who.name}-script`));
		adminSessions.set(key, await signInAsGroup(page, who, group, ADMIN_SCOPE));
	}
	return adminSessions.get(key);
}
async function admitAtHost(session, group, did) {
	await asGroup(
		session,
		'com.atproto.space.createRecord',
		post({
			space: group.members,
			repo: group.did,
			collection: 'org.atgrp.membership',
			rkey: did,
			record: {
				$type: 'org.atgrp.membership',
				roles: ['member'],
				createdAt: new Date().toISOString()
			}
		})
	);
}
const joinRequests = async (session) =>
	(await asGroup(session, 'org.atgrp.listJoinRequests?limit=100', { method: 'GET' })).requests ??
	[];
const metaRecord = async (session, group, collection) =>
	(
		await asGroup(
			session,
			`com.atproto.space.getRecord?${new URLSearchParams({ space: group.meta, repo: group.did, collection, rkey: 'self' })}`,
			{ method: 'GET' }
		)
	).value;
/** The host's own account of a group (its about and config records, as it reads them), for `who`. */
async function hostGroup(who, did) {
	const token = await serviceAuth(who, 'org.atgrp.internal.getGroup');
	const r = await getJson(`${HOST}/xrpc/org.atgrp.internal.getGroup?group=${did}`, {
		headers: { authorization: `Bearer ${token}` }
	});
	return r.body?.group ?? {};
}
const privateNow = new Set();
/** Puts a group the walk made private back to public, if it is still private. */
async function ensurePublic(g) {
	if (!privateNow.has(g.did)) return;
	await setMetaPublic(await adminFor(g, ALICE), g, true);
	privateNow.delete(g.did);
	if (g.linkedByAlice !== undefined || g === S.groups.gj) await reindex(g);
	// The host writes the declaration again; the index hears of it from Jetstream at an ingest cycle
	// (nobody who linked the group is looking at it to tell it sooner).
	const back = await until(
		async () => {
			await runCron();
			return status(S.pages.anon, groupUrl(g));
		},
		(x) => x === 200,
		15,
		2000
	);
	if (!back.ok) note(`${g.handle} is not back in the index after ${15 * 2} s`);
}
const groupUrl = (g) => `${ATMO}/groups/${g.did}`;
/** The first label of a group's handle: part of its address, which the groups search finds. */
const labelOf = (g) => g.handle.split('.')[0];
/** Signed out, what a search of /groups answers (on one server's page, with `server`): its HTML. */
const searchGroups = async (term, server) =>
	(
		await fetch(`${ATMO}/groups?${new URLSearchParams(server ? { q: term, server } : { q: term })}`)
	).text();

/** Has alice, linked to the group, open its page, which tells atmo's index what the host's repo now
 *  holds (its declaration added or taken away) without waiting for Jetstream. */
async function reindex(g) {
	const { alice } = S.pages;
	if (!g.linkedByAlice) {
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		g.linkedByAlice = true;
	}
	await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
}
/** Makes a public group at the host and has atmo's index know it (a declaration it has heard of from
 *  Jetstream, or, failing that, alice linking it from the app), so a step does not depend on what an
 *  earlier section did to any group. */
async function indexedGroup(label, name, options = {}) {
	const g = await createGroup(ALICE, label, name, options);
	Object.assign(g, spacesOf(g.did));
	const anon = S.pages.anon ?? (await pageFor('anon'));
	const heard = await until(
		async () => {
			await runCron();
			return status(anon, groupUrl(g));
		},
		(x) => x === 200,
		8,
		2000
	);
	if (!heard.ok) {
		const { alice } = S.pages;
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		g.linkedByAlice = true;
	}
	note(`${g.handle} is known to atmo's index (from Jetstream: ${heard.ok}, else linked by alice)`);
	return g;
}
const body = (page) =>
	page
		.locator('body')
		.innerText({ timeout: 15_000 })
		.then((t) => t.replace(/\s+/g, ' '));
/** From a page of atmo: press `button`, go through the PDS's consent (its text given to `seen`),
 *  and come back to atmo. */
async function allowOnPage(page, who, buttonName, seen) {
	await page.getByRole('button', { name: buttonName }).click();
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
	await through(page, who, (u) => u.origin === ATMO, {
		onConsent: async (p) => seen?.(await body(p))
	});
	await settle(page);
}
const MADE_UP_SITE = 'https://walkers.example.com';
/** The confirmations `who` holds in their own repo in a group's members space, read with a password
 *  session at their PDS. */
async function confirmationsOf(who, g) {
	const jwt = await pdsSession(who);
	const r = await getJson(
		`${who.pds}/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space: spacesOf(g.did).members, repo: who.did, collection: 'org.atgrp.confirmation' })}`,
		{ headers: { authorization: `Bearer ${jwt}` } }
	);
	return { status: r.status, count: (r.body?.records ?? []).length, text: r.text.slice(0, 160) };
}

// ---------- the group page as this build lays it out ----------
/** Parts of groups this build leaves out: their old steps stay in the file, skipped. */
const HELD_BACK = 'held back in this build';
/** The stacked parts of the feature, in order; a build of one has it and every part before it. */
const UNITS = ['link-group', 'join', 'members-only-events'];
const UNIT = process.env.WALK_UNIT?.trim() || UNITS.at(-1);
if (!UNITS.includes(UNIT)) throw new Error(`WALK_UNIT is one of ${UNITS.join(', ')}`);
/** Whether the build has `unit`. */
const has = (unit) => UNITS.indexOf(UNIT) >= UNITS.indexOf(unit);
const NOT_IN_UNIT = 'not in this unit';
const GROUPS_OFF = process.env.WALK_GROUPS_OFF_URL?.trim().replace(/\/$/, '') || '';
/** What the group's link asks for before members-only events: the meta read, the declaration and
 *  event repo writes, image upload. */
const LINK_UNIT_GROUP_SCOPES = [
	'atproto',
	'space:org.atgrp.meta?authority=self&skey=self&action=read',
	'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
	'blob?accept=image/*'
];
/** What the join unit adds to a person's client metadata: any group's meta read, their own
 *  confirmation in its members space, join, cancel and leave, and "Your groups". */
const JOIN_UNIT_PERSON_SCOPES = [
	'space:org.atgrp.meta?authority=*&skey=self&action=read',
	'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation&action=read&action=create&action=delete',
	'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
	'rpc:org.atgrp.internal.getActorGroups?aud=*'
];
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));
/** Before members-only events: the link asks this unit's scopes exactly, and the approval page lists
 *  no members-space access and withholds nothing. */
function onlyTheLinkUnitScopes(asked, access, withheld) {
	return (
		sameSet(asked.trim().split(/\s+/), LINK_UNIT_GROUP_SCOPES) &&
		access?.length === 0 &&
		withheld === ''
	);
}
/** The header: picture, name, badges, handle, description, counts, links, join state. */
const groupHeader = (page) => page.getByRole('region', { name: 'Group', exact: true });
/** The one box of tools for someone who linked the group and may act for it. */
const toolsBox = (page) => page.getByRole('region', { name: 'Group tools' });
/** The switch that lists the group in public group lists (its declaration in its repo). */
const listSwitch = (page) => page.getByRole('switch', { name: /^show in public group lists$/i });
/** The one members-space scope the group's link asks for: a read of the group's index of spaces. */
const SPACE_INDEX_SCOPE =
	'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.space&action=read';
/** On the console's approval page: each members-space access it lists, granted or withheld, with
 *  its data rows (a collection, and how many of create, update and delete are ticked). */
const membersSpaceAccess = (page) =>
	page.evaluate(() => {
		const out = [];
		for (const ul of document.querySelectorAll('ul.permissions')) {
			for (const block of ul.querySelectorAll('.space-access')) {
				const text = block.textContent.replace(/\s+/g, ' ');
				if (!text.includes('org.atgrp.members')) continue;
				out.push({
					withheld: ul.classList.contains('withheld'),
					manage: /Manage the spaces/i.test(text),
					rows: [...block.querySelectorAll('tbody tr')].map((tr) => ({
						collection: tr.querySelector('td')?.textContent.trim(),
						ticked: tr.querySelectorAll('td:not(:first-child) *').length
					}))
				});
			}
		}
		return out;
	});
/** Whether, of the members space, the asked scope names only that read, and the approval page
 *  grants it as a read of that one collection: no create, update or delete ticked, no managing. */
function onlyTheSpaceIndexRead(asked, access) {
	const members = asked.split(/\s+/).filter((x) => x.includes('org.atgrp.members'));
	return (
		members.length === 1 &&
		members[0] === SPACE_INDEX_SCOPE &&
		access?.length === 1 &&
		!access[0].withheld &&
		!access[0].manage &&
		access[0].rows.length === 1 &&
		access[0].rows[0].collection === 'org.atgrp.space' &&
		access[0].rows[0].ticked === 0
	);
}
/** The tools box's "Group host: <host>" button, to the group host's own site. */
const hostButton = (page) => toolsBox(page).getByRole('link', { name: /^group host:/i });
/** The group's own address, from its handle, which the group host serves its page at. */
const homeOf = (g) => `https://${g.handle}/`;
/** Flips the listing switch to `want` on the group's page, and waits for the declaration to follow
 *  in the group's repo. Whether it did. */
async function setListedBySwitch(page, g, want) {
	await page.goto(groupUrl(g), { waitUntil: 'networkidle' });
	const box = listSwitch(page);
	if ((await box.isChecked()) !== want) await box.click();
	const done = await until(
		() => repoRecords(g.did, DECLARATION),
		(rs) => rs.some((r) => r.rkey === 'self') === want
	);
	await page.goto(groupUrl(g), { waitUntil: 'networkidle' });
	return done.ok;
}
/** What a server answers at an address, with the address itself (and the relative paths that only
 *  follow from its depth) taken out of the body, so two unknown addresses can be compared. */
async function answerAt(pathname, init = {}) {
	const r = await fetch(`${ATMO}${pathname}`, { redirect: 'manual', ...init });
	const text = (await r.text())
		.split(pathname)
		.join('<path>')
		.replace(/(\.\.\/)+|\.\//g, '')
		.replace(/new URL\("[./]*", location\)/g, 'new URL(<base>)');
	return { status: r.status, text };
}
// A record key as atproto makes one: a TID, from the time in microseconds.
const TID_CHARS = '234567abcdefghijklmnopqrstuvwxyz';
let lastTid = 0n;
function tid() {
	let micros = BigInt(Date.now()) * 1000n;
	if (micros <= lastTid) micros = lastTid + 1n;
	lastTid = micros;
	let n = (micros << 10n) | 7n;
	let out = '';
	for (let i = 0; i < 13; i++) {
		out = TID_CHARS[Number(n & 31n)] + out;
		n >>= 5n;
	}
	return out;
}
/** Signs `who` in at the group host's console itself (its own sign-in, not an app's). */
async function consoleSignIn(page, who) {
	const button = page.getByRole('banner').getByRole('button', { name: /^sign in$/i });
	if (!(await button.isVisible().catch(() => false))) return;
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
	await button.click();
	const dialog = page.getByRole('dialog', { name: 'Sign in with your Atmosphere account' });
	const handle = dialog.getByRole('combobox', { name: 'Handle' });
	await handle.fill(who.handle);
	await handle.press('Enter');
	await page.waitForURL((u) => u.origin !== HOST, { timeout: 30_000 });
	await through(page, who, (u) => u.origin === HOST && !/oauth|callback/.test(u.pathname));
	await settle(page);
	await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
}
/** The DID a handle names, as the network serves it. */
async function didOfHandle(handle) {
	await makeResolvable(handle);
	const r = await fetch(`https://${handle}/.well-known/atproto-did`);
	return r.ok ? (await r.text()).trim() : null;
}

// =====================================================================================
// setup
// =====================================================================================
// atmo's own local database (the dev server's D1, LOCAL_STATE_DIR in the network file), read for
// the groups list's event index, which the scheduled job builds.
// WALK_ATMO_STATE_DIR names it when the dev server runs from another tree or with another one.
const D1_DIR = path.join(
	process.env.WALK_ATMO_STATE_DIR?.trim() ||
		new URL('../.wrangler/snowglobe-groups/', import.meta.url).pathname,
	'v3/d1/miniflare-D1DatabaseObject/'
);
const EVENT_INDEX = 'groups_event_did_starts';
function withD1(fn, readOnly = true) {
	const file = fs.existsSync(D1_DIR)
		? fs
				.readdirSync(D1_DIR)
				.filter((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
				.map((f) => path.join(D1_DIR, f))
				.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0]
		: null;
	if (!file) return null;
	const { DatabaseSync } = require('node:sqlite');
	const db = new DatabaseSync(file, { readOnly });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}
const eventIndexThere = () =>
	withD1(
		(db) =>
			db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").all(EVENT_INDEX)
				.length > 0
	);
/** Signed out, what /groups answers: its status, and whether it drew its lists. */
async function groupsListAnswers() {
	const r = await fetch(`${ATMO}/groups`);
	const html = await r.text();
	return {
		status: r.status,
		drawn: html.includes('group-search') && /Groups by server|Groups with events coming/i.test(html)
	};
}
// With WALK_EVENT_INDEX_TEST=1, on a dev server whose scheduled job has not run since it started
// (it builds the index once per isolate), the index is dropped first, to see the list answer
// without it and the next ingest cycle build it.
step('setup', 'groups-list-with-and-without-its-event-index', async () => {
	const fresh = Boolean(process.env.WALK_EVENT_INDEX_TEST);
	if (fresh) {
		withD1((db) => db.exec(`DROP INDEX IF EXISTS ${EVENT_INDEX}`), false);
		check(
			"the event index is absent from atmo's database (dropped for this check)",
			!eventIndexThere()
		);
		const before = await groupsListAnswers();
		check(
			'without it, /groups still answers, its lists drawn',
			before.status === 200 && before.drawn,
			JSON.stringify(before)
		);
	} else
		note(`the event index is ${eventIndexThere() ? 'there' : 'absent'} before the ingest cycle`);
	await runCron();
	check('after one ingest cycle (the scheduled job), the event index is there', eventIndexThere());
	const after = await groupsListAnswers();
	check(
		'...and /groups answers, its lists drawn',
		after.status === 200 && after.drawn,
		JSON.stringify(after)
	);
});

step(
	'setup',
	'network-answers',
	async () => {
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
		for (const who of [ALICE, BOB, MALLORY, DANA, CAROL])
			check(
				`${who.name}'s handle resolves for atmo's server`,
				await makeResolvable(who.handle),
				who.handle
			);
		// Before anything is written, so the index's place in Jetstream comes before this walk's records.
		await runCron();
		note(`run ${RUN}; the index has had one ingest cycle`);
	},
	{ needs: ['groups-list-with-and-without-its-event-index'] }
);

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
					members: await membersSpaceAccess(page),
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
				/space:org\.atgrp\.meta\?authority=self&(skey=self&)?action=read/.test(asked) &&
					/repo\?collection=org\.atgrp\.declaration|repo:org\.atgrp\.declaration/.test(asked) &&
					/community\.lexicon\.calendar\.event/.test(asked) &&
					/blob\?accept=image|blob:image/.test(asked),
				asked.trim().replace(/\s+/g, ' ')
			);
			const detail = approval.detail.replace(/\s+/g, ' ');
			const [granted, withheld = ''] = detail.split(/It would not get/i);
			if (!has('members-only-events'))
				check(
					`${UNIT}: an admin's grant keeps the meta read and the repo writes, and the approval page lists only this unit's permissions: the link asks exactly the meta read, the declaration and event repo writes and image upload; no members or calendar space; nothing withheld`,
					/Repository/.test(granted) &&
						/org\.atgrp\.declaration/.test(granted) &&
						/community\.lexicon\.calendar\.event/.test(granted) &&
						/org\.atgrp\.meta spaces/.test(granted) &&
						!/org\.atgrp\.members|calendar\.collection/.test(detail) &&
						onlyTheLinkUnitScopes(approval.asked, approval.members, withheld) &&
						!/listJoinRequests|denyJoinRequest|org\.atgrp\.about|org\.atgrp\.config/.test(detail),
					`${approval.asked.trim()} / ${JSON.stringify(approval.members)} / ${detail.slice(-900)}`
				);
			else
				check(
					"an admin's grant keeps the meta read, the repo writes and the one read of the group's space index; atmo asks for no other members or settings scope (held back in this build); only the calendar space's write is withheld, as no such space exists yet",
					/Repository/.test(granted) &&
						/org\.atgrp\.declaration/.test(granted) &&
						/community\.lexicon\.calendar\.event/.test(granted) &&
						/org\.atgrp\.meta spaces/.test(granted) &&
						onlyTheSpaceIndexRead(approval.asked, approval.members) &&
						!/listJoinRequests|denyJoinRequest|org\.atgrp\.about|org\.atgrp\.config/.test(detail) &&
						(withheld === '' ||
							(/community\.lexicon\.calendar\.collection/.test(withheld) &&
								!/org\.atgrp\./.test(withheld))),
					detail.slice(-900)
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
		// Groups linked by an earlier run of the walk are listed there too.
		const linked = (
			await alice
				.locator('section[aria-labelledby=linked-groups] li', { hasText: g.handle })
				.first()
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		check(
			'/groups lists it for alice under "Groups you\'ve linked", marked Linked, by the name the host gave it',
			linked.includes('Linked') && linked.includes(NAME),
			linked.slice(0, 300)
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
		const box = listSwitch(alice);
		check(
			'a public group made by createGroup shows as listed: the "Show in public group lists" switch is on, and may be turned off',
			(await box.count()) === 1 && (await box.isChecked()) && (await box.isEnabled())
		);
		// One linked view told the index, which does not otherwise hear of the host.
		// A group linked here counts as at the host at once, so no waiting for atmo's read of the host.
		const began = Date.now();
		const shown = await until(
			() => searchGroups(labelOf(g)).then((x) => x.includes(NAME)),
			(x) => x === true,
			20,
			1000
		);
		note(`listed for a visitor after ${Math.round((Date.now() - began) / 1000)} s`);
		check(
			'after one linked view, the group is in the index: signed out, a search of /groups by its address finds it',
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
		await anon.goto(`${ATMO}/groups?q=${labelOf(g)}`, { waitUntil: 'networkidle' });
		await anon.locator(`a[href$="/groups/${g.did}"]`).first().click();
		await anon.waitForURL((u) => u.pathname === `/groups/${g.did}`);
		await settle(anon);
		t.shot = anon;
		const text = await mainText(anon);
		check(
			'a signed-out visitor follows a search of /groups to its page, which names it and offers no controls',
			text.includes(NAME) &&
				(await anon.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
				(await anon.getByRole('button', { name: /unlink|groups list/i }).count()) === 0 &&
				(await listSwitch(anon).count()) === 0 &&
				(await toolsBox(anon).count()) === 0 &&
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
		const gone = await setListedBySwitch(alice, g, false);
		t.shot = alice;
		check(
			'alice turns "Show in public group lists" off: the declaration leaves the group\'s repo, and after a reload the switch is off',
			gone && !(await listSwitch(alice).isChecked()) && (await listSwitch(alice).isEnabled())
		);
		const hidden = await until(
			async () => {
				const s = await status(anon, url);
				await anon.goto(`${ATMO}/groups?q=${labelOf(g)}`, { waitUntil: 'networkidle' });
				return { s, listed: (await mainText(anon)).includes(NAME) };
			},
			(x) => x.s === 404 && !x.listed,
			10
		);
		check(
			'unlisted, a signed-out search of /groups no longer finds it, and its page is a 404 for a visitor',
			hidden.ok,
			JSON.stringify(hidden.last)
		);
		const back = await setListedBySwitch(alice, g, true);
		check(
			'alice turns it on again: the declaration is back in its repo, and after a reload the switch is on',
			back && (await listSwitch(alice).isChecked())
		);
		const shown = await until(
			async () => {
				const s = await status(anon, url);
				await anon.goto(`${ATMO}/groups?q=${labelOf(g)}`, { waitUntil: 'networkidle' });
				return { s, listed: (await mainText(anon)).includes(NAME) };
			},
			(x) => x.s === 200 && x.listed,
			10
		);
		check(
			'listed again, a visitor finds it by a search of /groups and sees its page',
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

// ---------- the group page laid out as a profile: its header, its home, its website ----------
step(
	'link',
	'header-for-a-visitor',
	async (t) => {
		const { anon } = S.pages;
		const g = S.groups.g1;
		await anon.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = anon;
		const header = groupHeader(anon);
		const text = (await header.innerText()).replace(/\s+/g, ' ');
		note(`the header, signed out: ${text.slice(0, 300)}`);
		check(
			'signed out, the header has the picture, the name, a "Group" badge, the handle and the description',
			(await header.getByRole('heading', { level: 1, name: NAME }).count()) === 1 &&
				(await header.locator('img, svg, [data-slot=avatar], span').count()) > 0 &&
				/\bGroup\b/.test(text) &&
				text.includes(`@${g.handle}`) &&
				text.includes('A made-up walking group'),
			text.slice(0, 300)
		);
		const stats = (
			await header
				.getByRole('definition')
				.or(header.locator('dl[aria-label="Group statistics"]'))
				.first()
				.innerText()
				.catch(() => '')
		).trim();
		check(
			'...and "N events created", counting its event',
			/\d+\s*events created/.test(text) && Number(text.match(/(\d+)\s*events created/)?.[1]) >= 1,
			`${stats} / ${text.slice(0, 200)}`
		);
		const home = header.getByRole('link', { name: /^group home/i });
		check(
			'..."Group home" is its own handle address, opened in a new tab',
			(await home.count()) === 1 &&
				(await home.getAttribute('href')) === homeOf(g) &&
				(await home.getAttribute('target')) === '_blank',
			`${await home.getAttribute('href').catch(() => null)} ${await home.getAttribute('target').catch(() => null)}`
		);
		check(
			'...no Website link, as its about record has no website',
			(await header.getByRole('link', { name: /^website/i }).count()) === 0
		);
		check(
			'...no join controls for a signed-out visitor, and no group tools',
			(await header.getByRole('button').count()) === 0 && (await toolsBox(anon).count()) === 0
		);
		check(
			'its events are laid out as on a profile, under "Upcoming Events"',
			(await anon.getByRole('heading', { name: /^upcoming events$/i }).count()) === 1 &&
				(await mainText(anon)).includes(RENAMED)
		);
		const [tab] = await Promise.all([anon.context().waitForEvent('page'), home.click()]);
		await tab.waitForLoadState('networkidle').catch(() => {});
		// The console draws the group once its script has run.
		await tab
			.locator('html[data-hydrated]')
			.waitFor({ state: 'attached', timeout: 30_000 })
			.catch(() => {});
		await tab
			.getByText(NAME)
			.or(tab.getByText(/sign in/i))
			.first()
			.waitFor({ timeout: 20_000 })
			.catch(() => {});
		const at = new URL(tab.url());
		const tabText = await tab
			.locator('body')
			.innerText()
			.catch(() => '');
		note(`"Group home" opened ${tab.url()}: ${tabText.replace(/\s+/g, ' ').slice(0, 160)}`);
		check(
			"following it opens the group host's own page for the group, in a new tab",
			at.origin === HOST &&
				decodeURIComponent(at.pathname) === `/g/${g.handle}` &&
				(tabText.includes(NAME) || tabText.includes(g.handle)),
			`${tab.url()} ${tabText.slice(0, 160)}`
		);
		await tab.close();
	},
	{ needs: ['visitor-sees-the-event'] }
);

// A group alice linked on an earlier build, whose link was approved for less than this build asks.
const OLDER_LINK = process.env.WALK_OLDER_LINK?.trim() || '';
step(
	'link',
	'an-older-link-is-asked-to-approve-again',
	async (t) => {
		const { alice } = S.pages;
		const url = `${ATMO}/groups/${OLDER_LINK}`;
		await alice.goto(url, { waitUntil: 'networkidle' });
		t.shot = alice;
		const prompt = alice.getByRole('button', { name: /^approve again$/i });
		const text = await mainText(alice);
		check(
			`the group alice linked on an earlier build (${OLDER_LINK}) shows "Approve again", saying her link was approved before atmo asked for all it can do`,
			(await prompt.count()) === 1 &&
				text.includes('Your link was approved before atmo asked for all it can do for a group.'),
			text.slice(0, 400)
		);
		let detail = '';
		await prompt.click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				detail = (
					(await page
						.locator('main form')
						.first()
						.textContent()
						.catch(() => '')) ?? ''
				).replace(/\s+/g, ' ');
			}
		});
		await settle(alice);
		await alice.goto(url, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'she approves at the console; back on the page, the prompt is gone',
			detail !== '' &&
				(await alice.getByRole('button', { name: /^approve again$/i }).count()) === 0 &&
				!(await mainText(alice)).includes('Your link was approved before'),
			(await mainText(alice)).slice(0, 300)
		);
	},
	{
		needs: ['people-sign-in'],
		todo: OLDER_LINK
			? null
			: 'needs WALK_OLDER_LINK, the DID of a group alice linked on an earlier build (a link approved for less than this build asks)'
	}
);

step(
	'link',
	'website-only-when-http',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = await indexedGroup(`ws${RUN}`, `Scar walkers ${RUN}`);
		S.groups.gs = g;
		if (!g.linkedByAlice) await reindex(g);
		const admin = await adminFor(g, ALICE);
		// The about record as createGroup wrote it (a space's records are read only with a space
		// credential, which this script does not make): the same name and description.
		const about = { displayName: g.name, description: `A made-up walking group, run ${RUN}.` };
		/** Puts the about record with `website`, as the group's admin, at the host; its answer. */
		const putWebsite = async (website) => {
			try {
				await asGroup(
					admin,
					'com.atproto.space.putRecord',
					post({
						space: g.meta,
						repo: g.did,
						collection: 'org.atgrp.about',
						rkey: 'self',
						record: { ...about, $type: 'org.atgrp.about', website }
					})
				);
				return 'taken';
			} catch (e) {
				return e.message;
			}
		};
		/** The Website link in the header, after alice's linked view has told the index. */
		const websiteFor = async (page) => {
			await page.goto(groupUrl(g), { waitUntil: 'networkidle' });
			const link = groupHeader(page).getByRole('link', { name: /^website/i });
			return (await link.count()) ? await link.getAttribute('href') : null;
		};
		const set = await putWebsite(MADE_UP_SITE);
		note(`the host answered the about record with an https website: ${set}`);
		await reindex(g);
		const shown = await until(
			async () => ({ alice: await websiteFor(alice), anon: await websiteFor(anon) }),
			(x) => x.alice !== null && x.anon !== null,
			10,
			1000
		);
		t.shot = anon;
		check(
			'with an https website in its about record (set as its admin at the host), the header links "Website", for alice and for a visitor',
			set === 'taken' &&
				new URL(shown.last.alice ?? 'x:').origin === MADE_UP_SITE &&
				new URL(shown.last.anon ?? 'x:').origin === MADE_UP_SITE,
			JSON.stringify(shown.last)
		);
		const link = groupHeader(anon).getByRole('link', { name: /^website/i });
		check(
			'...opened in a new tab, that cannot reach back',
			(await link.getAttribute('target').catch(() => null)) === '_blank' &&
				/noopener/.test((await link.getAttribute('rel').catch(() => '')) ?? '')
		);
		const bad = await putWebsite('javascript:alert(document.domain)');
		note(`the host answered the about record with a javascript: website: ${bad}`);
		await reindex(g);
		// The host may refuse such a website, so the group keeps its https one; else the link goes.
		const refused = bad !== 'taken';
		const now = await until(
			async () => ({ alice: await websiteFor(alice), anon: await websiteFor(anon) }),
			(x) =>
				refused
					? new URL(x.alice ?? 'x:').origin === MADE_UP_SITE &&
						new URL(x.anon ?? 'x:').origin === MADE_UP_SITE
					: x.alice === null && x.anon === null,
			10,
			1000
		);
		const scripted =
			(await alice.locator('a[href^="javascript:" i]').count()) +
			(await anon.locator('a[href^="javascript:" i]').count());
		check(
			refused
				? 'a javascript: website is refused by the host (so the group keeps its https one, still linked), and no javascript: link is anywhere on the page, for alice or a visitor'
				: 'with a javascript: website, no Website link shows, for alice or a visitor, and no javascript: link anywhere on the page',
			now.ok && scripted === 0,
			`${bad} ${JSON.stringify(now.last)}`
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'link',
	'profile-address-leads-to-the-group',
	async (t) => {
		const { anon, alice } = S.pages;
		const g = S.groups.g1;
		const answers = {};
		for (const key of [g.handle, g.did]) {
			const r = await fetch(`${ATMO}/p/${key}`, { redirect: 'manual' });
			answers[key] = `${r.status} ${r.headers.get('location')}`;
			check(
				`/p/${key === g.did ? '<the group DID>' : '<the group handle>'} redirects to /groups/<its DID>`,
				[301, 302, 303, 307, 308].includes(r.status) &&
					new URL(r.headers.get('location') ?? '/', ATMO).pathname === `/groups/${g.did}`,
				answers[key]
			);
			await anon.goto(`${ATMO}/p/${key}`, { waitUntil: 'networkidle' });
			check(
				'...and a browser lands on the group page',
				new URL(anon.url()).pathname === `/groups/${g.did}` &&
					(await groupHeader(anon).getByRole('heading', { name: NAME }).count()) === 1,
				anon.url()
			);
		}
		const signedIn = await fetch(`${ATMO}/p/${g.handle}`, {
			redirect: 'manual',
			headers: {
				cookie: (await alice.context().cookies(ATMO)).map((c) => `${c.name}=${c.value}`).join('; ')
			}
		});
		check(
			'signed in too',
			[301, 302, 303, 307, 308].includes(signedIn.status) &&
				new URL(signedIn.headers.get('location') ?? '/', ATMO).pathname === `/groups/${g.did}`,
			String(signedIn.status)
		);
		const person = await fetch(`${ATMO}/p/${ALICE.handle}`, { redirect: 'manual' });
		await anon.goto(`${ATMO}/p/${ALICE.handle}`, { waitUntil: 'networkidle' });
		t.shot = anon;
		const text = await mainText(anon);
		check(
			"a person's /p/ page is not redirected: 200 at its own address, her profile, with no group header",
			person.status === 200 &&
				new URL(anon.url()).pathname === `/p/${ALICE.handle}` &&
				(await groupHeader(anon).count()) === 0 &&
				(text.includes(ALICE.handle) || /alice/i.test(text)),
			`${person.status} ${anon.url()} ${text.slice(0, 200)}`
		);
	},
	{ needs: ['listed-by-the-host'] }
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

step(
	'link',
	'linking-again-revokes-the-old-grant',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.g1;
		// The grants atmo holds for the group, as the console's page for apps lists them.
		const grants = async () => {
			await alice.goto(`${HOST}/g/${g.handle}/settings/apps`, { waitUntil: 'networkidle' });
			await alice.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
			await settle(alice);
			return alice.getByRole('button', { name: /^revoke .*atmo\.app.*access$/i }).count();
		};
		const before = await grants();
		const since = new Date(Date.now() - 1000);
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		t.shot = alice;
		check(
			'alice links the group again while her link still works, and lands on it linked',
			new URL(alice.url()).searchParams.get('link') === 'linked' &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			alice.url()
		);
		const revokes = hostRequests(since).filter((r) => /revoke/i.test(r.route ?? ''));
		note(
			`the host saw: ${revokes.map((r) => `${r.method} ${r.route} ${r.status}`).join(', ') || 'no revoke call'}`
		);
		check(
			'atmo revoked the grant the new link replaced: the host answered its revoke 200',
			revokes.some((r) => r.status === 200)
		);
		const after = await grants();
		t.shot = alice;
		check(
			'the console lists as many atmo grants as before, not one more',
			before >= 1 && after === before,
			`${before} -> ${after}`
		);
	},
	{ needs: ['delete-event'] }
);

// ---------- browsing /groups: what is coming up, each server's list, search ----------
const HOST_NAME = new URL(HOST).host;
/** The group host's row on /groups: its counts, as shown. */
async function hostRow(page) {
	await page.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	const row = page.locator('section[aria-labelledby=by-server] li', { hasText: HOST_NAME }).first();
	const text = (await row.innerText().catch(() => '')).replace(/\s+/g, ' ');
	const m = text.match(/(\d+) groups?, (\d+) with events coming up/);
	return { text, groups: m ? Number(m[1]) : null, upcoming: m ? Number(m[2]) : null };
}
/** A group's row under "Groups with events coming up", through up to `pages` pages; null if absent. */
async function upcomingRow(page, name, pages = 8) {
	await page.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	const section = page.locator('section[aria-labelledby=upcoming]');
	for (let i = 0; i < pages; i++) {
		const item = section.locator('li', { hasText: name }).first();
		if (await item.count())
			return {
				text: (await item.innerText()).replace(/\s+/g, ' '),
				datetime: await item.locator('time').getAttribute('datetime'),
				page: i + 1
			};
		const more = section.getByRole('link', { name: /more groups/i });
		if (!(await more.count())) return null;
		await page.goto(new URL(await more.getAttribute('href'), ATMO).href, {
			waitUntil: 'networkidle'
		});
	}
	return null;
}
const hostPageUrl = () => `${ATMO}/groups?${new URLSearchParams({ server: HOST })}`;
/** Signed out, the DIDs a paged list links to, through every page: the host's own list, or the
 *  whole list's groups with events coming up. */
async function listedDids(first) {
	const dids = new Set();
	let url = first;
	for (let i = 0; i < 30 && url; i++) {
		const html = await (await fetch(url)).text();
		for (const m of html.matchAll(/\/groups\/(did:[a-z0-9:]+)/g)) dids.add(m[1]);
		const next = html.match(/[?&;]cursor=([^"&]+)/);
		url = next ? `${first}${first.includes('?') ? '&' : '?'}cursor=${next[1]}` : null;
	}
	return dids;
}
async function linkByAlice(g) {
	if (g.linkedByAlice) return;
	const { alice } = S.pages;
	await startLink(alice, g.handle);
	await through(alice, ALICE, (u) => u.origin === ATMO);
	await settle(alice);
	g.linkedByAlice = true;
}

step(
	'link',
	'browse-signed-out',
	async (t) => {
		const { alice, anon } = S.pages;
		const before = await hostRow(anon);
		const beforeDids = await listedDids(hostPageUrl());
		note(`the host's row before: ${before.text}; its own list has ${beforeDids.size}`);
		// Listed, with an event coming up; listed, with none; private; and listed, then unlisted.
		// Linked by alice, whose view of each page tells the index at once, without waiting for an
		// ingest cycle to hear of the declarations.
		const listed = async (label, name) => {
			const g = await createGroup(ALICE, label, name);
			await linkByAlice(g);
			await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
			return g;
		};
		const bu = await listed(`bu${RUN}`, `Busy fell ${RUN}`);
		const bn = await listed(`bn${RUN}`, `Bare fell ${RUN}`);
		const bp = await createGroup(ALICE, `bp${RUN}`, `Shut fold ${RUN}`, { publicRead: false });
		const bl = await listed(`bl${RUN}`, `Hidden tarn ${RUN}`);
		const coming = `Fell race ${RUN}`;
		await linkByAlice(bu);
		await alice.goto(`${groupUrl(bu)}/events/new`, { waitUntil: 'networkidle' });
		await editorPublish(alice, coming);
		await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 60_000 });
		await linkByAlice(bl);
		await setListedBySwitch(alice, bl, false);

		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			'signed out, /groups starts with the search box',
			(await anon.locator('#group-search').getAttribute('placeholder')) ===
				'Search by address or name'
		);
		const row = await until(
			() => upcomingRow(anon, bu.name),
			(x) => x !== null,
			10,
			2000
		);
		t.shot = anon;
		check(
			'a group with a public event coming up is under "Groups with events coming up", with the event\'s title and date',
			row.ok && row.last.text.includes(coming) && Boolean(row.last.datetime),
			JSON.stringify(row.last)
		);
		if (row.ok) note(`found on page ${row.last.page}: ${row.last.text}`);
		const absent = {};
		for (const g of [bn, bp, bl]) absent[g.name] = (await upcomingRow(anon, g.name)) === null;
		check(
			'a listed group with no event, a private one and an unlisted one are not there',
			Object.values(absent).every(Boolean),
			JSON.stringify(absent)
		);
		const hostPage = await (await fetch(hostPageUrl())).text();
		check(
			"the listed group with no event is on its host's page",
			hostPage.includes(bn.name) && hostPage.includes(bu.name)
		);
		check(
			'...the private and the unlisted ones are not',
			!hostPage.includes(bp.did) && !hostPage.includes(bl.did)
		);
		const found = await searchGroups(labelOf(bn).slice(0, -2));
		check('a search by part of its address finds the listed group', found.includes(bn.name));
		const hidden = [
			await searchGroups(labelOf(bp)),
			await searchGroups(labelOf(bl)),
			await searchGroups(bp.name),
			await searchGroups(bl.name),
			await searchGroups(labelOf(bp), HOST),
			await searchGroups(labelOf(bl), HOST)
		];
		check(
			"a search, on the whole list or on the host's page, finds neither the private nor the unlisted group",
			// By their DIDs, which only a result's link carries: the page repeats what was searched for.
			hidden.every((h) => !h.includes(bp.did) && !h.includes(bl.did)),
			hidden.map((h) => `${h.includes(bp.did)}/${h.includes(bl.did)}`).join(' ')
		);
		// The counts, against the lists they count: other runs' groups come and go meanwhile.
		const after = await until(
			async () => {
				const row = await hostRow(anon);
				const all = await listedDids(hostPageUrl());
				const coming = await listedDids(`${ATMO}/groups`);
				return { row, all, coming };
			},
			(x) => x.row.groups === x.all.size && x.row.upcoming === x.coming.size,
			10,
			2000
		);
		const { row: rowAfter, all, coming: comingDids } = after.last;
		const added = [...all].filter((d) => !beforeDids.has(d));
		const dropped = [...beforeDids].filter((d) => !all.has(d));
		note(
			`the host's row after: ${rowAfter.text}; its list has ${all.size}, the coming-up list ${comingDids.size}; new on the list: ${added.join(' ')}; gone from it: ${dropped.join(' ') || 'none'}`
		);
		check(
			"the host's row counts its list (groups) and the coming-up list (events coming up)",
			after.ok,
			`${rowAfter.text} / ${all.size} / ${comingDids.size}`
		);
		check(
			'...of which the groups made here are the two listed ones, and only the one with an event is coming up',
			added.includes(bu.did) &&
				added.includes(bn.did) &&
				!all.has(bp.did) &&
				!all.has(bl.did) &&
				comingDids.has(bu.did) &&
				!comingDids.has(bn.did),
			added.join(' ')
		);
		S.browse = { bn };
	},
	{ needs: ['people-sign-in'] }
);

step(
	'link',
	'host-page-and-its-search',
	async (t) => {
		const { anon } = S.pages;
		const { bn } = S.browse;
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		await anon.getByRole('link', { name: `See all groups at ${HOST_NAME}` }).click();
		await anon.waitForURL((u) => u.searchParams.get('server') !== null, { timeout: 20_000 });
		await settle(anon);
		check(
			'"See all" opens the host\'s own list',
			new URL(anon.url()).searchParams.get('server') === HOST &&
				(await mainText(anon)).includes(bn.name),
			anon.url()
		);
		await anon.fill('#group-search', labelOf(bn));
		await anon.getByRole('button', { name: /^search$/i }).click();
		await anon.waitForURL((u) => u.searchParams.get('q') !== null, { timeout: 20_000 });
		await settle(anon);
		t.shot = anon;
		const at = new URL(anon.url());
		check(
			'searching there stays on that host, and finds the group',
			at.searchParams.get('server') === HOST &&
				(await mainText(anon)).includes(bn.name) &&
				(await mainText(anon)).includes(`Search the groups at ${HOST_NAME}`),
			anon.url()
		);
	},
	{ needs: ['browse-signed-out'] }
);

step(
	'link',
	'private-linked-group-only-for-its-linker',
	async (t) => {
		const { alice, bob, anon } = S.pages;
		const g = await createGroup(ALICE, `bv${RUN}`, `Walled garth ${RUN}`);
		Object.assign(g, spacesOf(g.did));
		await linkByAlice(g);
		await setMetaPublic(await adminFor(g, ALICE), g, false);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const asks = (await alice.getByRole('button', { name: /^allow joining groups$/i }).count()) > 0;
		const linked = (
			await alice
				.locator('section[aria-labelledby=linked-groups]')
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		if (has('join'))
			check(
				'alice, whose sign-in has not granted the join permissions, sees the private group she linked under "Groups you\'ve linked"',
				// A private group's name is not kept for the list, so it is shown by its handle.
				asks && linked.includes(g.handle),
				`asks for join permissions: ${asks}; ${linked.slice(0, 300)}`
			);
		else
			check(
				`${UNIT}: alice sees the private group she linked under "Groups you've linked", and /groups asks for no join permissions (no "Allow joining groups")`,
				!asks && linked.includes(g.handle),
				`asks for join permissions: ${asks}; ${linked.slice(0, 300)}`
			);
		await bob.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			'bob, signed in, and a signed-out visitor do not see it on /groups, nor by a search',
			!(await bob.content()).includes(g.did) &&
				!(await anon.content()).includes(g.did) &&
				!(await searchGroups(labelOf(g))).includes(g.did)
		);
	},
	{ needs: ['people-sign-in'] }
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
		const box = listSwitch(alice);
		check(
			'the page shows the Private badge; the "Show in public group lists" switch is off and disabled, with its reason: "Only a public group can be in them."',
			(await groupHeader(alice).innerText()).includes('Private') &&
				(await box.count()) === 1 &&
				!(await box.isChecked()) &&
				(await box.isDisabled()) &&
				text.includes('Only a public group can be in them.'),
			text.slice(0, 400)
		);
		const gone = await until(
			async () => {
				await anon.goto(`${ATMO}/groups?q=${labelOf(g)}`, { waitUntil: 'networkidle' });
				return (await mainText(anon)).includes(NAME);
			},
			(x) => x === false,
			15
		);
		check('a signed-out visitor no longer finds it by a search of /groups', gone.ok);
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
			'the page shows it as listed (the switch on, and enabled), without the Private badge',
			(await listSwitch(alice).isChecked()) &&
				(await listSwitch(alice).isEnabled()) &&
				!(await groupHeader(alice).innerText()).includes('Private')
		);
		const shown = await until(
			async () => {
				await anon.goto(`${ATMO}/groups?q=${labelOf(g)}`, { waitUntil: 'networkidle' });
				return (await mainText(anon)).includes(NAME);
			},
			(x) => x,
			15
		);
		check('a signed-out visitor finds it by a search of /groups again', shown.ok);
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
				(await listSwitch(bob).count()) === 0 &&
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
		const linked = (
			await alice
				.locator('section[aria-labelledby=linked-groups]')
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		const found = await searchGroups(labelOf(g));
		check(
			'alice unlinks it: it leaves "Groups you\'ve linked", and a search still finds it',
			!linked.includes(g.handle) && found.includes(NAME),
			linked.slice(0, 300)
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
// more groups, made at the host by script, for the steps that follow
// =====================================================================================
step(
	'setup',
	'more-groups',
	async () => {
		const ga = await createGroup(ALICE, `ga${RUN}`, `Ash court ${RUN}`, {
			stewards: [MALLORY.did]
		});
		const go = await createGroup(ALICE, `go${RUN}`, `Open fell ${RUN}`, { joinPolicy: 'open' });
		const gi = await createGroup(ALICE, `gi${RUN}`, `Inner circle ${RUN}`, {
			joinPolicy: 'invite'
		});
		Object.assign(S.groups, { ga, go, gi });
		for (const g of [ga, go, gi]) {
			g.meta = spacesOf(g.did).meta;
			g.members = spacesOf(g.did).members;
			check(`${g.name} is made at the host (${g.handle})`, g.did?.startsWith('did:plc:'));
		}
		// Whether atmo's index hears of them from Jetstream alone (the relay follows the host).
		for (const g of [go, gi]) {
			const heard = await until(
				async () => {
					await runCron();
					return status(S.pages.anon ?? (await pageFor('anon')), groupUrl(g));
				},
				(x) => x === 200,
				8,
				2000
			);
			if (!heard.ok) {
				// Not yet: linking it from the app tells the index, as a person would.
				const { alice } = S.pages;
				await startLink(alice, g.handle);
				await through(alice, ALICE, (u) => u.origin === ATMO);
				await settle(alice);
			}
			note(`${g.handle}: the index heard from Jetstream and cron: ${heard.ok}`);
		}
		check(
			'both are on atmo for a visitor',
			(await status(S.pages.anon, groupUrl(go))) === 200 &&
				(await status(S.pages.anon, groupUrl(gi))) === 200
		);
	},
	{ needs: ['alice-makes-groups', 'people-sign-in'] }
);

// =====================================================================================
// link, additions: a plain member links a group; an admin whose role is lowered
// =====================================================================================
step(
	'link',
	'member-links-the-group-and-can-do-little',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.ga;
		const asked = await hostCall(BOB, 'org.atgrp.requestJoin', { group: g.did });
		check(
			'bob asks to join the group, as his PDS vouches for him (by script)',
			asked.status === 200 && asked.body?.status === 'pending',
			`${asked.status} ${asked.text.slice(0, 120)}`
		);
		await admitAtHost(await adminFor(g, ALICE), g, BOB.did);
		check('its founder admits him at the host, as a plain member', true);
		let approval = '';
		await startLink(bob, g.handle);
		await through(bob, BOB, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				approval = await mainText(page);
			}
		});
		await settle(bob);
		t.shot = bob;
		note(`the console offered bob: ${approval.slice(0, 300)}`);
		check(
			'bob, a member, links the group through the console',
			new URL(bob.url()).pathname === `/groups/${g.did}` &&
				new URL(bob.url()).searchParams.get('link') === 'linked',
			bob.url()
		);
		const text = await mainText(bob);
		check(
			'his page offers no Post, list or Settings controls, and no Edit links',
			(await bob.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
				(await bob.getByRole('button', { name: /groups list/i }).count()) === 0 &&
				(await listSwitch(bob).count()) === 0 &&
				(await bob
					.locator('main')
					.getByRole('button', { name: /^settings$/i })
					.count()) +
					(await bob
						.locator('main')
						.getByRole('link', { name: /^settings$/i })
						.count()) ===
					0 &&
				(await bob
					.locator('main')
					.getByRole('link', { name: /^edit$/i })
					.count()) === 0,
			text.slice(0, 300)
		);
		check(
			'...and says what his role lets him do',
			text.includes(
				'Your role in this group lets you see it here, but not post its events or list it.'
			),
			text.slice(0, 300)
		);
		const res = await bob.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		const reason = await body(bob);
		check(
			'the new-event page answers 403 with the reason',
			res?.status() === 403 && /doesn.t let you post/i.test(reason),
			`${res?.status()} ${reason.slice(0, 200)}`
		);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
	},
	{ needs: ['more-groups', 'people-sign-in'] }
);

step(
	'link',
	'lowered-role-refuses-the-save',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups[process.env.DBG_G ?? 'ga'];
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		const title = `Fell run ${RUN}`;
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		await editorPublish(alice, title);
		await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 60_000 });
		const rkey = new URL(alice.url()).pathname.split('/').pop();
		const posted = await until(
			() => repoRecords(g.did, EVENTS),
			(rs) => rs.some((r) => r.rkey === rkey)
		);
		check('alice, an admin, posts an event as the group', posted.ok);
		// Another admin, the steward mallory, lowers alice to a plain member at the host.
		const page = await pageFor('mallory-script');
		const session = await signInAsGroup(page, MALLORY, g, ADMIN_SCOPE);
		await asGroup(
			session,
			'com.atproto.space.putRecord',
			post({
				space: g.members,
				repo: g.did,
				collection: 'org.atgrp.membership',
				rkey: ALICE.did,
				record: {
					$type: 'org.atgrp.membership',
					roles: ['member'],
					createdAt: new Date().toISOString()
				}
			})
		);
		check('mallory, another admin, lowers alice to a plain member at the host', true);
		const logAt = atmoLogSize();
		await alice.goto(`${groupUrl(g)}/events/${rkey}/edit`, { waitUntil: 'networkidle' });
		const field = alice.locator('main [contenteditable=true]').first();
		await field.waitFor({ timeout: 60_000 });
		await field.click();
		await alice.keyboard.press('End');
		await alice.keyboard.type(' again');
		await alice.getByRole('button', { name: /^save changes$/i }).click();
		await sleep(3000);
		t.shot = alice;
		const text = await body(alice);
		check(
			'her save shows the reason above the editor: her role no longer allows it',
			/no longer allows that/i.test(text) && alice.url().includes('/edit'),
			text.slice(0, 300)
		);
		const log = atmoLogSince(logAt);
		const line =
			log.split('\n').find((l) => l.includes('putRecord') && l.includes(ALICE.did)) ?? '';
		check(
			"atmo's log shows the host's refusal as 403, not 502",
			/putRecord for .*: 403/.test(line) &&
				!/ 502 /.test(log.split('\n').find((l) => /putRecord/.test(l) && /502/.test(l)) ?? ''),
			line || log.slice(-300)
		);
		const after = await repoRecords(g.did, EVENTS);
		check(
			'the event in the group repo is unchanged',
			after.find((r) => r.rkey === rkey)?.value?.name === title
		);
	},
	{ needs: ['more-groups', 'people-sign-in'] }
);

// =====================================================================================
// create: in this build a group is made at the group host, then linked here. Making one from the
// app and its settings page are held back; their old steps stay below, skipped.
// =====================================================================================
const AT_HOST = { label: `hm${RUN}`, name: `Beck club ${RUN}` };
step(
	'create',
	'make-a-group-goes-to-the-host',
	async (t) => {
		const { alice, anon } = S.pages;
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const make = alice.locator('main').getByRole('link', { name: /^make a group/i });
		const text = await mainText(alice);
		check(
			`signed in, /groups's "Make a group" links to the group host's own ${HOST}/new, in a new tab, with "Make the group at the group host, then link it here."`,
			(await make.count()) === 1 &&
				(await make.getAttribute('href')) === `${HOST}/new` &&
				(await make.getAttribute('target')) === '_blank' &&
				text.includes('Make the group at the group host, then link it here.'),
			`${await make.getAttribute('href').catch(() => null)} ${text.slice(0, 200)}`
		);
		check(
			'...and nothing on the page links to /groups/create',
			(await alice.locator('a[href$="/groups/create"]').count()) === 0
		);
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			'signed out, there is no "Make a group"',
			(await anon
				.locator('main')
				.getByRole('link', { name: /^make a group/i })
				.count()) === 0
		);
		const [tab] = await Promise.all([alice.context().waitForEvent('page'), make.click()]);
		await tab.waitForLoadState('networkidle').catch(() => {});
		S.newGroupTab = tab;
		check(
			"following it opens the group host's /new page in a new tab",
			tab.url().split('?')[0] === `${HOST}/new`,
			tab.url()
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'create',
	'made-at-the-host-then-linked',
	async (t) => {
		const { alice } = S.pages;
		const tab = S.newGroupTab;
		t.shot = tab;
		// The console's own sign-in, if this browser has none there yet, then its form.
		await consoleSignIn(tab, ALICE);
		if (tab.url().split('?')[0] !== `${HOST}/new`)
			await tab.goto(`${HOST}/new`, { waitUntil: 'networkidle' });
		await tab.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 30_000 });
		await tab.locator('input[name=displayName]').fill(AT_HOST.name);
		await tab.locator('input[name=label]').fill(AT_HOST.label);
		await tab
			.locator('textarea[name=description]')
			.fill(`A made-up group, made at the host, run ${RUN}.`);
		await tab.locator('select[name=joinPolicy]').selectOption('approval');
		await tab.getByRole('button', { name: /start the group/i }).click();
		await tab.waitForURL((u) => u.pathname.startsWith('/g/'), { timeout: 60_000 });
		await settle(tab);
		// Past the recovery key page, unread, if the console shows one.
		if (await tab.locator('#recovery').count()) {
			await tab.click('#continue');
			await tab.locator('#recovery').waitFor({ state: 'detached', timeout: 45_000 });
		}
		const handle = decodeURIComponent(new URL(tab.url()).pathname.split('/')[2]);
		const did = await didOfHandle(handle);
		check(
			"alice makes a group with the console's own form; it is at the host under the address she chose",
			handle === `${AT_HOST.label}.${GROUP_DOMAIN}` && Boolean(did?.startsWith('did:')),
			`${tab.url()} ${did}`
		);
		const g = { did, handle, name: AT_HOST.name, ...spacesOf(did) };
		S.groups.gh = g;
		note(`made at the host: ${did} (${handle})`);
		await tab.close();
		await startLink(alice, handle);
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		t.shot = alice;
		g.linkedByAlice = true;
		const landed = new URL(alice.url());
		check(
			'she links it here by its handle, and lands on its page with the group tools: "Post an event"',
			landed.pathname === `/groups/${did}` &&
				landed.searchParams.get('link') === 'linked' &&
				(await toolsBox(alice)
					.getByRole('link', { name: /^post an event$/i })
					.count()) === 1 &&
				(await groupHeader(alice).getByRole('heading', { name: AT_HOST.name }).count()) === 1,
			alice.url()
		);
		const declared = await until(
			() => repoRecords(did, DECLARATION),
			(r) => r.some((x) => x.rkey === 'self'),
			20
		);
		check(
			'the host made it public and listed (its declaration is in its repo), and the switch says so',
			declared.ok && (await listSwitch(alice).isChecked()),
			JSON.stringify(declared.last?.map((r) => r.rkey))
		);
	},
	{ needs: ['make-a-group-goes-to-the-host'] }
);

step(
	'create',
	'held-back-addresses-answer-as-unknown',
	async (t) => {
		const g = S.groups.gh ?? S.groups.g1;
		const cookie = (await S.pages.alice.context().cookies(ATMO))
			.map((c) => `${c.name}=${c.value}`)
			.join('; ');
		for (const [who, init] of [
			['signed out', {}],
			['signed in', { headers: { cookie } }]
		]) {
			const unknownGroupPage = await answerAt(`/groups/${g.did}/no-such-page`, init);
			const unknownSite = await answerAt(`/no-such-place-${RUN}`, init);
			// A held-back address that a group route also matches (/groups/create reads as a group named
			// "create") answers as a made-up group does, which is a 404 too.
			const unknownGroup = await answerAt(`/groups/nosuchgroup${RUN}`, init);
			note(
				`${who}: a made-up address in the group answers ${unknownGroupPage.status}, one outside groups ${unknownSite.status}, a made-up group ${unknownGroup.status}`
			);
			for (const [label, p, likes] of [
				[
					'/groups/create',
					'/groups/create',
					[
						['a made-up address outside groups', unknownSite],
						['a made-up group', unknownGroup]
					]
				],
				[
					'/groups/<did>/settings',
					`/groups/${g.did}/settings`,
					[
						['a made-up address in the group', unknownGroupPage],
						['a made-up group', unknownGroup]
					]
				],
				[
					'/groups/<did>/members',
					`/groups/${g.did}/members`,
					[
						['a made-up address in the group', unknownGroupPage],
						['a made-up group', unknownGroup]
					]
				]
			]) {
				const got = await answerAt(p, init);
				const as = likes.find(([, like]) => got.status === like.status && got.text === like.text);
				note(
					`${who}, ${label}: ${got.status}, ${as ? `the same body as ${as[0]}` : 'a body like no made-up address'}${/group not found/i.test(got.text) ? ' ("Group not found")' : ''}`
				);
				check(
					`${who}, ${label} answers exactly as a made-up address does (status and body)`,
					got.status === 404 && as !== undefined && got.status === unknownSite.status,
					`${got.status}, bodies ${likes.map(([n, like]) => `${n}: ${like.status} ${got.text === like.text ? 'same' : `differ (${got.text.length} / ${like.text.length})`}`).join('; ')}`
				);
			}
			const posted = await answerAt(`/groups/${g.did}/settings`, {
				...init,
				method: 'POST',
				headers: {
					...(init.headers ?? {}),
					'content-type': 'application/x-www-form-urlencoded',
					origin: ATMO
				},
				body: 'name=x'
			});
			const postedUnknown = await answerAt(`/groups/${g.did}/no-such-page`, {
				...init,
				method: 'POST',
				headers: {
					...(init.headers ?? {}),
					'content-type': 'application/x-www-form-urlencoded',
					origin: ATMO
				},
				body: 'name=x'
			});
			check(
				`${who}, a form post to the settings address answers as one to a made-up address`,
				posted.status === postedUnknown.status && posted.text === postedUnknown.text,
				`${posted.status} / ${postedUnknown.status}`
			);
		}
		const { alice } = S.pages;
		await reindex(g);
		t.shot = alice;
		check(
			'the group page, for alice who linked it, has no Settings or Members link into this site',
			(await alice.locator(`a[href$="/groups/${g.did}/settings"]`).count()) === 0 &&
				(await alice.locator(`a[href*="/groups/${g.did}/members"]`).count()) === 0 &&
				(await alice
					.locator('main')
					.getByRole('link', { name: /^(settings|members)\s*→?$/i })
					.count()) === 0
		);
		const atHost = hostButton(alice);
		check(
			`...but "Group host: ${HOST_NAME}", to the group host's own site, in a new tab`,
			(await atHost.count()) === 1 &&
				new URL((await atHost.getAttribute('href')) ?? 'x:').origin === HOST &&
				(await atHost.getAttribute('target')) === '_blank',
			`${await atHost.getAttribute('href').catch(() => null)}`
		);
	},
	{ needs: ['people-sign-in', 'alice-makes-groups'] }
);

const NEW = { label: `cr${RUN}`, name: `Moor club ${RUN}` };
async function fillGroupForm(page, { name, address, description, join, visibility, listed }) {
	await page.fill('#group-name', name);
	if (address !== undefined) await page.fill('#group-address', address);
	if (description !== undefined) await page.fill('#group-description', description);
	if (join) await page.locator('#group-join').selectOption(join);
	if (visibility) await page.locator(`input[name=visibility][value=${visibility}]`).check();
	if (listed !== undefined) {
		const box = page.getByRole('checkbox', { name: /list it on the groups page/i });
		if ((await box.isChecked()) !== listed && (await box.isEnabled())) await box.click();
	}
}
/** Submits the create form and goes through the console, approving for the group named. */
async function makeThroughApp(page, form, { approve = true } = {}) {
	await makeResolvable(`${form.address}.${GROUP_DOMAIN}`);
	await page.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
	await page.locator('html').waitFor();
	await fillGroupForm(page, form);
	await page.getByRole('button', { name: /^make the group$/i }).click();
	await page.waitForURL((u) => u.origin !== ATMO || u.pathname !== '/groups/create', {
		timeout: 60_000
	});
	let consoleText = '';
	if (new URL(page.url()).origin !== HOST) return { consoleText: '' };
	if (!approve) {
		await page.waitForLoadState('networkidle').catch(() => {});
		return { consoleText: '' };
	}
	await through(page, ALICE, (u) => u.origin === ATMO, {
		onApprove: async (p) => {
			consoleText = await mainText(p);
		}
	});
	await settle(page);
	return { consoleText };
}

step(
	'create',
	'allow-making-groups',
	async (t) => {
		const { alice } = S.pages;
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'the create page offers "Allow making groups" before there is a form',
			(await alice.getByRole('button', { name: /^allow making groups$/i }).count()) === 1 &&
				(await alice.locator('#group-name').count()) === 0
		);
		let consent = '';
		await allowOnPage(alice, ALICE, /^allow making groups$/i, (x) => (consent = x));
		t.shot = alice;
		check(
			"her PDS's consent asks to act on her behalf (it words the createGroup grant only so: it does not name the method)",
			/perform actions on your behalf/i.test(consent),
			consent.slice(0, 600)
		);
		note(`her PDS asked: ${consent.slice(0, 1500)}`);
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		const text = await mainText(alice);
		check(
			"the form comes back, with the host's domain after the address",
			(await alice.locator('#group-name').count()) === 1 && text.includes(GROUP_DOMAIN),
			text.slice(0, 300)
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'create',
	'make-a-public-listed-group',
	async (t) => {
		const { alice } = S.pages;
		const { consoleText } = await makeThroughApp(alice, {
			name: NEW.name,
			address: NEW.label,
			description: `Made from the app, run ${RUN}.`,
			join: 'approval',
			visibility: 'public',
			listed: true
		});
		t.shot = alice;
		const handle = `${NEW.label}.${GROUP_DOMAIN}`;
		note(`the console offered: ${consoleText.slice(0, 300)}`);
		check(
			"the host's console opened with the new group preselected, and only it",
			consoleText.includes(handle) &&
				!/no group you can sign it in as/i.test(consoleText) &&
				(consoleText.match(/Sign it in as/g) ?? []).length === 1,
			consoleText.slice(0, 300)
		);
		const landed = new URL(alice.url());
		const did = landed.pathname.split('/')[2];
		S.groups.cr = { did, handle, name: NEW.name };
		Object.assign(S.groups.cr, spacesOf(did));
		check(
			'after approval she lands on the group with the made-and-linked notice',
			landed.searchParams.get('link') === 'created' &&
				(await mainText(alice)).includes('Your group is made, and linked.'),
			alice.url()
		);
		check(
			'...and a Settings button',
			(await alice
				.locator('main')
				.getByRole('link', { name: /^settings$/i })
				.count()) +
				(await alice
					.locator('main')
					.getByRole('button', { name: /^settings$/i })
					.count()) >=
				1
		);
		const shown = await until(
			() => searchGroups(NEW.label).then((x) => x.includes(NEW.name)),
			(x) => x,
			15,
			1000
		);
		check('a signed-out search of /groups finds it at once', shown.ok);
		const decl = await repoRecords(did, DECLARATION);
		check('the host holds its declaration', decl.length === 1);
	},
	{ needs: ['allow-making-groups'] }
);

step(
	'create',
	'unlisted-group-has-no-declaration',
	async (t) => {
		const { alice, anon } = S.pages;
		const label = `un${RUN}`;
		const name = `Quiet beck ${RUN}`;
		const handle = `${label}.${GROUP_DOMAIN}`;
		// Made, and stopped at the console's approval page: its first link has not finished.
		await makeThroughApp(
			alice,
			{ name, address: label, join: 'approval', visibility: 'public', listed: false },
			{ approve: false }
		);
		check('the console opens for it', new URL(alice.url()).origin === HOST, alice.url());
		const did = (await (await fetch(`https://${handle}/.well-known/atproto-did`)).text()).trim();
		const g = { did, handle, name, ...spacesOf(did) };
		S.groups.un = g;
		const session = await adminFor(g, ALICE);
		const policy = async () =>
			(
				await asGroup(
					session,
					`com.atproto.space.getSpace?${new URLSearchParams({ space: g.meta })}`,
					{ method: 'GET' }
				)
			).policy;
		const early = await policy();
		const earlyDecl = await repoRecords(did, DECLARATION);
		check(
			'"public, not listed": until its first link finishes, the group is private at the host, with no declaration',
			early.publicRead !== true && earlyDecl.length === 0,
			`${JSON.stringify(early)} / ${earlyDecl.length} declarations`
		);
		check(
			'...and a signed-out search of /groups does not find it',
			!(await searchGroups(label)).includes(name)
		);
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await alice
			.locator('form', { hasText: label })
			.getByRole('button', { name: /^finish setting up$/i })
			.click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		t.shot = alice;
		check(
			'"Finish setting up" links it',
			new URL(alice.url()).pathname === `/groups/${did}` &&
				['linked', 'created'].includes(new URL(alice.url()).searchParams.get('link') ?? ''),
			alice.url()
		);
		const late = await policy();
		check('once linked it is public at the host', late.publicRead === true, JSON.stringify(late));
		// Made public, the host writes a declaration, which the first link's setup takes away.
		await sleep(3000);
		const decl = await repoRecords(did, DECLARATION);
		check('...with no declaration at the host', decl.length === 0, String(decl.length));
		const list = await searchGroups(label);
		check('...and a signed-out search of /groups does not find it', !list.includes(name));
		check(
			'...and its page is a 404 for a visitor',
			(await status(anon, groupUrl(S.groups.un))) === 404
		);
		check(
			'...while its admin sees it, with the option to list it',
			(await alice
				.goto(groupUrl(S.groups.un))
				.then(() => alice.getByRole('button', { name: /^add to the groups list$/i }).count())) === 1
		);
	},
	{ needs: ['allow-making-groups'] }
);

step(
	'create',
	'members-only-group-is-not-found-signed-out',
	async (t) => {
		const { alice, anon } = S.pages;
		const label = `mo${RUN}`;
		const name = `Closed barn ${RUN}`;
		await makeThroughApp(alice, { name, address: label, join: 'approval', visibility: 'private' });
		t.shot = alice;
		const did = new URL(alice.url()).pathname.split('/')[2];
		S.groups.mo = { did, handle: `${label}.${GROUP_DOMAIN}`, name };
		check(
			"a members-only group's page is a 404 signed out",
			(await status(anon, groupUrl(S.groups.mo))) === 404
		);
		check(
			'...and a signed-out search of /groups does not find it',
			!(await searchGroups(label)).includes(name)
		);
		check(
			'...while its admin reaches it, with the Private badge',
			(await alice.goto(groupUrl(S.groups.mo)).then(() => mainText(alice))).includes('Private')
		);
	},
	{ needs: ['allow-making-groups'] }
);

step(
	'create',
	'same-address-again-is-taken',
	async (t) => {
		const { alice } = S.pages;
		await makeResolvable(`${NEW.label}.${GROUP_DOMAIN}`);
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await fillGroupForm(alice, { name: 'Another moor club', address: NEW.label });
		await alice.getByRole('button', { name: /^make the group$/i }).click();
		await alice.waitForLoadState('networkidle');
		t.shot = alice;
		const text = await body(alice);
		check(
			'the same address again, for a group she linked, says the address is taken',
			/that address is taken/i.test(text) && new URL(alice.url()).origin === ATMO,
			text.slice(0, 300)
		);
	},
	{ needs: ['make-a-public-listed-group'] }
);

step(
	'create',
	'double-submit-offers-finish-setting-up',
	async (t) => {
		const { alice } = S.pages;
		const label = `ds${RUN}`;
		const name = `Twice pressed ${RUN}`;
		const handle = `${label}.${GROUP_DOMAIN}`;
		await makeResolvable(handle);
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await fillGroupForm(alice, { name, address: label, join: 'approval', visibility: 'private' });
		// The button is off once the form is sent.
		const button = alice.getByRole('button', { name: /^make the group$/i });
		const posts = [];
		alice.on('request', (r) => {
			if (r.method() === 'POST' && new URL(r.url()).pathname === '/groups/create') posts.push(r);
		});
		await button.dblclick();
		await alice.waitForURL((u) => u.origin !== ATMO || u.pathname !== '/groups/create', {
			timeout: 60_000
		});
		check(
			'a double click on "Make the group" sends the form once',
			posts.length === 1,
			`${posts.length} POSTs`
		);
		// Approved, so no half-made group is left for the steps after this one.
		if (new URL(alice.url()).origin === HOST) {
			await through(alice, ALICE, (u) => u.origin === ATMO);
			await settle(alice);
		}
		// Two presses that both reach the server, as from two tabs: the second is told the group is
		// hers already, and offered to finish it.
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		const label2 = `dt${RUN}`;
		const name2 = `Pressed again ${RUN}`;
		await makeResolvable(`${label2}.${GROUP_DOMAIN}`);
		const answers = await alice.evaluate(
			async ([n, a]) => {
				const send = () => {
					const form = new FormData();
					form.set('name', n);
					form.set('address', a);
					form.set('description', '');
					form.set('joinPolicy', 'approval');
					form.set('visibility', 'private');
					return fetch('/groups/create', {
						headers: { accept: 'text/html' },
						method: 'POST',
						body: form,
						redirect: 'manual'
					}).then(async (r) => ({
						status: r.status,
						type: r.type,
						text: await r.text().catch(() => '')
					}));
				};
				return Promise.all([send(), send()]);
			},
			[name2, label2]
		);
		note(
			`the two sends were answered ${answers.map((x) => `${x.status}/${x.type}`).join(' and ')}`
		);
		const started = answers.filter((x) => x.type === 'opaqueredirect').length;
		const offered = answers.filter(
			(x) =>
				x.status === 409 &&
				/made this group already/i.test(x.text) &&
				/finish setting up/i.test(x.text)
		).length;
		check(
			'of two sends of the same form, one starts the link and the other offers "Finish setting up"',
			started === 1 && offered === 1,
			answers
				.map(
					(x) =>
						`${x.status} ${x.text
							.replace(/<[^>]+>/g, ' ')
							.replace(/\s+/g, ' ')
							.slice(0, 160)}`
				)
				.join(' | ')
		);
		// The same address sent again from the page, once the group is made, offers the same.
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await fillGroupForm(alice, {
			name: name2,
			address: label2,
			join: 'approval',
			visibility: 'private'
		});
		await alice.getByRole('button', { name: /^make the group$/i }).click();
		await alice.getByRole('alert').waitFor({ timeout: 30_000 });
		await settle(alice);
		t.shot = alice;
		const text = await mainText(alice);
		const finish = alice.locator('form', { hasText: label2 }).getByRole('button', {
			name: /^finish setting up$/i
		});
		check(
			're-sending the address of the group she just made says she made it already, and offers "Finish setting up"',
			/made this group already/i.test(text) && (await finish.count()) >= 1,
			text.slice(0, 300)
		);
		await finish.first().click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		check(
			'...which links it',
			['linked', 'created'].includes(new URL(alice.url()).searchParams.get('link') ?? '') &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			alice.url()
		);
	},
	{ needs: ['allow-making-groups'] }
);

step(
	'create',
	'unfinished-group-can-be-finished',
	async (t) => {
		const { alice } = S.pages;
		const label = `uf${RUN}`;
		const name = `Half done ${RUN}`;
		await makeThroughApp(alice, { name, address: label, join: 'approval' }, { approve: false });
		check('the console opens for it', new URL(alice.url()).origin === HOST, alice.url());
		// Closed without approving: back to atmo.
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'the groups page says a group is not set up yet',
			/not set up yet/i.test(await mainText(alice))
		);
		await alice.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		const text = await mainText(alice);
		check(
			'the create page lists it under "Not set up yet", with "Finish setting up"',
			/not set up yet/i.test(text) &&
				text.includes(`${label}.${GROUP_DOMAIN}`) &&
				(await alice.getByRole('button', { name: /^finish setting up$/i }).count()) >= 1,
			text.slice(0, 300)
		);
		await alice
			.locator('form', { hasText: label })
			.getByRole('button', { name: /^finish setting up$/i })
			.click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO);
		await settle(alice);
		t.shot = alice;
		const did = new URL(alice.url()).pathname.split('/')[2];
		S.groups.uf = { did, handle: `${label}.${GROUP_DOMAIN}`, name };
		check(
			'"Finish setting up" links it: she lands on the group (made-and-linked notice) with its controls',
			['linked', 'created'].includes(new URL(alice.url()).searchParams.get('link') ?? '') &&
				(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
			alice.url()
		);
		await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			'and the groups page no longer says it is unfinished',
			!/not set up yet/i.test(await mainText(alice))
		);
	},
	{ needs: ['allow-making-groups'] }
);

step(
	'create',
	'settings-change-and-records',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.cr;
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await alice
			.locator('main')
			.getByRole('link', { name: /^settings$/i })
			.click();
		await alice.waitForURL((u) => u.pathname.endsWith('/settings'));
		await alice.locator('#group-name').waitFor();
		S.newName = `Moor club renamed ${RUN}`;
		await alice.fill('#group-name', S.newName);
		await alice.fill('#group-description', 'A new description.');
		await alice.fill('#group-website', MADE_UP_SITE);
		await alice.locator('#group-join').selectOption('open');
		await alice.getByRole('button', { name: /^save$/i }).click();
		await alice.waitForURL((u) => u.pathname === `/groups/${g.did}`, { timeout: 30_000 });
		await settle(alice);
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'saved settings come back to the group page with the new name and description',
			text.includes(S.newName) && text.includes('A new description.'),
			text.slice(0, 200)
		);
		const at = await hostGroup(ALICE, g.did);
		note(
			`the host's own account of it: ${JSON.stringify({ ...at, viewer: undefined, labels: undefined })}`
		);
		check(
			"the host's about record (as it reports it) holds the new name, description and website",
			at.displayName === S.newName &&
				at.description === 'A new description.' &&
				String(at.website).startsWith(MADE_UP_SITE),
			JSON.stringify(at).slice(0, 300)
		);
		check(
			"the host's config record says anyone may join",
			at.joinPolicy === 'open',
			String(at.joinPolicy)
		);
		await alice.goto(`${groupUrl(g)}/settings`, { waitUntil: 'networkidle' });
		check(
			'the settings form shows the saved values',
			(await alice.inputValue('#group-name')) === S.newName &&
				(await alice.inputValue('#group-website')).startsWith(MADE_UP_SITE) &&
				(await alice.locator('#group-join').inputValue()) === 'open',
			`${await alice.inputValue('#group-name')} | ${await alice.inputValue('#group-website')} | ${await alice.locator('#group-join').inputValue()}`
		);
		const listed = await until(
			() => searchGroups(NEW.label).then((x) => x.includes(S.newName)),
			(x) => x,
			10,
			1000
		);
		note(`the renamed group on the signed-out list: ${listed.ok}`);
	},
	{ needs: ['make-a-public-listed-group'] }
);

step(
	'create',
	'settings-members-only-and-back',
	async (t) => {
		const { alice, anon } = S.pages;
		const g = S.groups.cr;
		const session = await adminFor(g, ALICE);
		const before = (
			await asGroup(
				session,
				`com.atproto.space.getSpace?${new URLSearchParams({ space: g.meta })}`,
				{ method: 'GET' }
			)
		).policy;
		const save = async (visibility, listed) => {
			await alice.goto(`${groupUrl(g)}/settings`, { waitUntil: 'networkidle' });
			await alice.locator(`input[name=visibility][value=${visibility}]`).check();
			const box = alice.getByRole('checkbox', { name: /list it on the groups page/i });
			if ((await box.isEnabled()) && (await box.isChecked()) !== listed) await box.click();
			await alice.getByRole('button', { name: /^save$/i }).click();
			await alice.waitForURL((u) => u.pathname === `/groups/${g.did}`, { timeout: 30_000 });
			await settle(alice);
		};
		await save('private', false);
		t.shot = alice;
		const after = (
			await asGroup(
				session,
				`com.atproto.space.getSpace?${new URLSearchParams({ space: g.meta })}`,
				{ method: 'GET' }
			)
		).policy;
		check(
			"made members-only, the meta space's grants are unchanged and only publicRead changed",
			JSON.stringify(after.grants) === JSON.stringify(before.grants) && after.publicRead !== true,
			`${JSON.stringify(before)} -> ${JSON.stringify(after)}`
		);
		const gone = await until(
			async () => ({
				s: await status(anon, groupUrl(g)),
				listed: (await searchGroups(NEW.label)).includes(S.newName)
			}),
			(x) => x.s === 404 && !x.listed,
			15,
			1000
		);
		check(
			'signed out, its page is a 404 and it is gone from the list',
			gone.ok,
			JSON.stringify(gone.last)
		);
		await save('public', true);
		const back = await until(
			async () => ({
				s: await status(anon, groupUrl(g)),
				listed: (await searchGroups(NEW.label)).includes(S.newName)
			}),
			(x) => x.s === 200 && x.listed,
			15,
			1000
		);
		check('made public and listed again, it shows signed out', back.ok, JSON.stringify(back.last));
		check(
			'...and its declaration is back at the host',
			(await repoRecords(g.did, DECLARATION)).length === 1
		);
	},
	{ needs: ['settings-change-and-records'] }
);

step('create', 'todo-approve-again-for-an-old-link', async () => {}, {
	todo: 'a link approved before the settings scope existed needs a stored link whose asked scope is out of date (a key atmo writes at the link) and whose grant lacks something; this run starts from a fresh database, and nothing in the pages can make one without changing app code'
});

// =====================================================================================
// join: ask, cancel, be admitted, leave; groups that admit at once or take invitations only
// =====================================================================================
step(
	'join',
	'join-group',
	async () => {
		const g = await indexedGroup(`jn${RUN}`, `Tarn walkers ${RUN}`);
		S.groups.gj = g;
		check(
			`${g.name} is made at the host and known to atmo (${g.handle})`,
			g.did?.startsWith('did:plc:')
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'join',
	'bob-allows-joining-groups',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		check(
			'bob opens a group whose admins decide, and is offered "Allow joining groups"',
			(await bob.getByRole('button', { name: /^allow joining groups$/i }).count()) === 1
		);
		let consent = '';
		await allowOnPage(bob, BOB, /^allow joining groups$/i, (x) => (consent = x));
		t.shot = bob;
		note(`his PDS asked: ${consent.slice(0, 1500)}`);
		check(
			'his PDS asks for the permissions (it words acting in groups and the groups list generally), and the page then has the join form',
			/perform actions on your behalf|space/i.test(consent) && consent.length > 0,
			consent.slice(0, 600)
		);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		check(
			'back on the page, there is a message box and "Ask to join"',
			(await bob.getByRole('button', { name: /^ask to join$/i }).count()) === 1 &&
				(await bob.locator('#join-message').count()) === 1
		);
	},
	{ needs: ['join-group'] }
);

step(
	'join',
	'bob-asks-with-a-message-and-sees-it-waiting',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		S.joinMessage = `Hello from bob, run ${RUN}`;
		await bob.fill('#join-message', S.joinMessage);
		await bob.getByRole('button', { name: /^ask to join$/i }).click();
		await bob.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		t.shot = bob;
		check(
			'he sees the request waiting, and a way to cancel it',
			(await bob.getByRole('button', { name: /^cancel request$/i }).count()) === 1
		);
		const admin = await adminFor(g, ALICE);
		const asking = (await joinRequests(admin)).find((r) => r.member === BOB.did);
		check(
			'at the host, the request is there with his message',
			asking?.message === S.joinMessage,
			JSON.stringify(asking)
		);
	},
	{ needs: ['bob-allows-joining-groups'] }
);

step(
	'join',
	'bob-cancels-and-asks-again',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		const admin = await adminFor(g, ALICE);
		await bob.getByRole('button', { name: /^cancel request$/i }).click();
		await bob.getByRole('button', { name: /^ask to join$/i }).waitFor({ timeout: 20_000 });
		const gone = !(await joinRequests(admin)).some((r) => r.member === BOB.did);
		check('he cancels: the request is gone at the host and the page offers to ask again', gone);
		await bob.fill('#join-message', S.joinMessage);
		await bob.getByRole('button', { name: /^ask to join$/i }).click();
		await bob.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		t.shot = bob;
		check(
			'asking again is a request again',
			(await joinRequests(admin)).some((r) => r.member === BOB.did)
		);
		check(
			"the request's state, with its Cancel, is in the group's header",
			(await groupHeader(bob)
				.getByRole('button', { name: /^cancel request$/i })
				.count()) === 1 && /request sent/i.test(await groupHeader(bob).innerText())
		);
	},
	{ needs: ['bob-asks-with-a-message-and-sees-it-waiting'] }
);

step(
	'join',
	'linked-admin-is-sent-to-the-host',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		await reindex(g);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = alice;
		const tools = toolsBox(alice);
		const text = ((await tools.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
		check(
			'alice, an admin who linked it, sees in "Group tools" that its name, description, who may join, members, requests to join and roles are changed at its group host, named',
			text.includes(
				`The group's name, description and who may join are changed at its group host, ${HOST_NAME}`
			) && text.includes('as are its members, requests to join and roles.'),
			text.slice(0, 500)
		);
		const inSentence = tools.locator('p').getByRole('link', { name: new RegExp(`^${HOST_NAME}`) });
		const there = hostButton(alice);
		const hrefs = [
			await inSentence.getAttribute('href').catch(() => null),
			await there.getAttribute('href').catch(() => null)
		];
		check(
			`...the sentence's link and the "Group host: ${HOST_NAME}" button go to the group host's own site (not the group's address), in a new tab`,
			(await there.count()) === 1 &&
				(await inSentence.count()) === 1 &&
				hrefs.every((h) => h && new URL(h).origin === HOST && h !== homeOf(g)) &&
				(await there.getAttribute('target')) === '_blank' &&
				(await inSentence.getAttribute('target')) === '_blank',
			hrefs.join(' ')
		);
		// Followed, the button opens the host's site in a new tab; the header's "Group home" the
		// group's own address (which the host serves as its page for the group).
		const [hostTab] = await Promise.all([alice.context().waitForEvent('page'), there.click()]);
		await hostTab.waitForLoadState('networkidle').catch(() => {});
		const homeLink = groupHeader(alice).getByRole('link', { name: /^group home/i });
		const homeName = ((await homeLink.innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ');
		const [homeTab] = await Promise.all([alice.context().waitForEvent('page'), homeLink.click()]);
		await homeTab.waitForLoadState('networkidle').catch(() => {});
		note(`"Group host" opened ${hostTab.url()}; "${homeName}" opened ${homeTab.url()}`);
		check(
			`"Group host: ${HOST_NAME}" opens the group host's site; "Group home: ${g.handle}" opens the group's address (the host's page for it)`,
			new URL(hostTab.url()).origin === HOST &&
				homeName.includes(g.handle) &&
				(await homeLink.getAttribute('href')) === homeOf(g) &&
				new URL(homeTab.url()).origin === HOST &&
				decodeURIComponent(new URL(homeTab.url()).pathname) === `/g/${g.handle}`,
			`${hostTab.url()} / ${homeName} -> ${homeTab.url()}`
		);
		await hostTab.close();
		await homeTab.close();
		const page = await mainText(alice);
		check(
			"...and no list of requests here: bob's waiting request and its message are not on the page, and there is no Members link or approve button",
			!page.includes(S.joinMessage) &&
				(await alice.locator('ul[aria-label="Asking to join"]').count()) === 0 &&
				(await alice.getByRole('button', { name: /^(approve|deny|decline)$/i }).count()) === 0 &&
				(await alice.locator(`a[href*="/groups/${g.did}/members"]`).count()) === 0,
			page.slice(0, 300)
		);
		check(
			'there is ONE "Group tools" box, holding Post an event, the listing switch, the group host button and Unlink',
			(await alice.getByRole('heading', { name: /^group tools$/i }).count()) === 1 &&
				(await tools.getByRole('link', { name: /^post an event$/i }).count()) === 1 &&
				(await tools.getByRole('switch', { name: /^show in public group lists$/i }).count()) ===
					1 &&
				(await tools.getByRole('button', { name: /^unlink$/i }).count()) === 1
		);
	},
	{ needs: ['bob-cancels-and-asks-again'] }
);

step(
	'join',
	'admitted-at-the-host-bob-is-a-member',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		await admitAtHost(await adminFor(g, ALICE), g, BOB.did);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		check(
			'the admin admits him at the host (by script); on reload bob sees he is a member, with a way to leave, in the header',
			(await groupHeader(bob)
				.getByRole('button', { name: /^leave group$/i })
				.count()) === 1 && /\bMember\b/.test(await groupHeader(bob).innerText())
		);
		// His confirmation is written on that visit; the same write again, as the second visit makes it.
		const jwt = await pdsSession(BOB);
		const again = await getJson(`${BOB.pds}/xrpc/com.atproto.space.createRecord`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
			body: JSON.stringify({
				space: spacesOf(g.did).members,
				repo: BOB.did,
				collection: 'org.atgrp.confirmation',
				rkey: 'self',
				record: { $type: 'org.atgrp.confirmation', createdAt: new Date().toISOString() }
			})
		});
		note(
			`a second write of his confirmation is answered ${again.status} ${again.body?.error ?? ''}`
		);
		const read = await getJson(
			`${BOB.pds}/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space: spacesOf(g.did).members, repo: BOB.did, collection: 'org.atgrp.confirmation' })}`,
			{ headers: { authorization: `Bearer ${jwt}` } }
		);
		check(
			'his confirmation is in his own repo (the first visit wrote it)',
			again.status === 400 || (read.body?.records ?? []).length >= 1,
			`${again.status} ${again.text.slice(0, 120)} / ${read.status} ${read.text.slice(0, 120)}`
		);
		await bob.reload({ waitUntil: 'networkidle' });
		check(
			'a second visit still shows him a member',
			(await bob.getByRole('button', { name: /^leave group$/i }).count()) === 1
		);
	},
	{ needs: ['bob-cancels-and-asks-again'] }
);

step(
	'join',
	'private-group-is-still-seen-by-a-member',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		const admin = await adminFor(g, ALICE);
		await setMetaPublic(admin, g, false);
		privateNow.add(g.did);
		await reindex(g);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		const text = await mainText(bob);
		check(
			'the group is made private at the host, and bob still sees it, with its name',
			text.includes(S.groups.gj.name) &&
				(await bob.getByRole('button', { name: /^leave group$/i }).count()) === 1,
			text.slice(0, 200)
		);
		// The index drops the declaration when it hears of it, from Jetstream at the next ingest cycle.
		const hidden = await until(
			async () => {
				await runCron();
				return status(S.pages.anon, groupUrl(g));
			},
			(x) => x === 404,
			30,
			2000
		);
		check('while a signed-out visitor gets a 404', hidden.ok, String(hidden.last));
	},
	{ needs: ['admitted-at-the-host-bob-is-a-member'] }
);

step(
	'join',
	'your-groups-lists-it',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		await bob.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		t.shot = bob;
		const section = bob.locator('section', {
			has: bob.getByRole('heading', { name: /your groups/i })
		});
		const text = (await section.innerText().catch(() => '')).replace(/\s+/g, ' ');
		check(
			'/groups lists it under his groups, though it is private',
			text.includes(S.groups.gj.name) || text.includes(g.handle),
			text.slice(0, 300)
		);
		// Back to public for the steps that follow.
		await ensurePublic(g);
	},
	{ needs: ['private-group-is-still-seen-by-a-member'] }
);

step(
	'join',
	'bob-leaves-and-may-ask-again',
	async (t) => {
		await ensurePublic(S.groups.gj);
		const { bob } = S.pages;
		const g = S.groups.gj;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const held = await confirmationsOf(BOB, g);
		await bob.getByRole('button', { name: /^leave group$/i }).click();
		await bob.getByRole('button', { name: /^ask to join$/i }).waitFor({ timeout: 20_000 });
		t.shot = bob;
		check('bob leaves, and is offered to ask again', true);
		const left = await until(
			() => confirmationsOf(BOB, g),
			(x) => x.status === 200 && x.count === 0,
			20
		);
		check(
			'his confirmation, in his own repo before he left, is deleted once the host took the leave',
			held.count >= 1 && left.ok,
			`${JSON.stringify(held)} -> ${JSON.stringify(left.last)}`
		);
		await bob.reload({ waitUntil: 'networkidle' });
		check(
			'on the next visit too',
			(await bob.getByRole('button', { name: /^ask to join$/i }).count()) === 1 &&
				(await bob.getByRole('button', { name: /^leave group$/i }).count()) === 0
		);
	},
	{ needs: ['your-groups-lists-it'] }
);

step(
	'join',
	'founder-cannot-leave-as-the-only-admin',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await alice.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(alice, ALICE, /^allow joining groups$/i);
			await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		await alice.getByRole('button', { name: /^leave group$/i }).click();
		await alice.getByRole('alert').waitFor({ timeout: 20_000 });
		t.shot = alice;
		const text = await body(alice);
		check(
			'the founder trying to leave sees the only-admin message',
			/only admin, so you can.t leave it/i.test(text),
			text.slice(0, 300)
		);
		check(
			'and is still a member',
			(await alice.getByRole('button', { name: /^leave group$/i }).count()) === 1
		);
	},
	{ needs: ['bob-leaves-and-may-ask-again'] }
);

step(
	'join',
	'open-group-admits-at-once',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.go;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		check(
			'an open group offers "Join"',
			(await bob.getByRole('button', { name: /^join$/i }).count()) === 1,
			(await mainText(bob)).slice(0, 200)
		);
		await bob.getByRole('button', { name: /^join$/i }).click();
		await bob.getByRole('button', { name: /^leave group$/i }).waitFor({ timeout: 20_000 });
		check('joining admits him at once: he is a member', true);
		const written = await until(
			() => confirmationsOf(BOB, g),
			(x) => x.count >= 1,
			20
		);
		check(
			"joining here wrote his confirmation in his own repo, in the group's members space",
			written.ok,
			JSON.stringify(written.last)
		);
	},
	{ needs: ['bob-allows-joining-groups', 'more-groups'] }
);

step(
	'join',
	'invitation-only-group-says-so',
	async (t) => {
		const { bob } = S.pages;
		await bob.goto(groupUrl(S.groups.gi), { waitUntil: 'networkidle' });
		t.shot = bob;
		const text = await mainText(bob);
		check(
			'an invitation-only group says it takes members by invitation only, and offers no join',
			/invitation only/i.test(text) &&
				(await bob.getByRole('button', { name: /^(join|ask to join)$/i }).count()) === 0,
			text.slice(0, 200)
		);
	},
	{ needs: ['bob-allows-joining-groups', 'more-groups'] }
);

step(
	'join',
	'carol-without-spaces-gets-an-explanation',
	async (t) => {
		await ensurePublic(S.groups.gj);
		const carol = await signInToAtmo(CAROL);
		const g = S.groups.gj;
		await carol.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = carol;
		check(
			'carol (a PDS without spaces) opens the group and is offered "Allow joining groups"',
			(await carol.getByRole('button', { name: /^allow joining groups$/i }).count()) === 1
		);
		await allowOnPage(carol, CAROL, /^allow joining groups$/i);
		t.shot = carol;
		const text = await mainText(carol);
		check(
			'back from her PDS, the page explains her server gave no permission',
			/did not give atmo permission to act for you in groups/i.test(text),
			text.slice(0, 300)
		);
		check(
			'...names a server with spaces support',
			text.includes(new URL(ALPHA).host),
			text.slice(0, 300)
		);
		check(
			'...and does not ask again: no "Allow joining groups" button',
			(await carol.getByRole('button', { name: /^allow joining groups$/i }).count()) === 0
		);
	},
	{ needs: ['join-group'] }
);

step(
	'join',
	'dana-on-the-other-spaces-pds-asks-and-is-admitted',
	async (t) => {
		await ensurePublic(S.groups.gj);
		const dana = await signInToAtmo(DANA);
		const g = S.groups.gj;
		await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await allowOnPage(dana, DANA, /^allow joining groups$/i);
		t.shot = dana;
		check(
			'dana (the other PDS with spaces) is granted the permissions and offered "Ask to join"',
			(await dana.getByRole('button', { name: /^ask to join$/i }).count()) === 1,
			(await mainText(dana)).slice(0, 200)
		);
		await dana.fill('#join-message', 'Dana here');
		await dana.getByRole('button', { name: /^ask to join$/i }).click();
		await dana.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		const admin = await adminFor(g, ALICE);
		check(
			'her request reaches the host',
			(await joinRequests(admin)).some((r) => r.member === DANA.did)
		);
		await admitAtHost(admin, g, DANA.did);
		await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		check(
			'admitted at the host, she is a member on her next visit',
			(await dana.getByRole('button', { name: /^leave group$/i }).count()) === 1
		);
	},
	{ needs: ['join-group'] }
);

// =====================================================================================
// roster: the members page, for an admin who linked the group and for a member. Held back in this
// build: every step but the first is skipped (see the end of the file), and the first checks that
// its address answers as an unknown one.
// =====================================================================================
step(
	'roster',
	'members-address-answers-as-unknown',
	async (t) => {
		const g = S.groups.g1;
		const cookie = (await S.pages.alice.context().cookies(ATMO))
			.map((c) => `${c.name}=${c.value}`)
			.join('; ');
		const unknown = await answerAt(`/groups/${g.did}/no-such-page`);
		for (const [who, init] of [
			['signed out', {}],
			['signed in as the founder', { headers: { cookie } }]
		]) {
			const like = await answerAt(`/groups/${g.did}/no-such-page`, init);
			for (const p of [`/groups/${g.did}/members`, `/groups/${g.did}/members/requests`]) {
				const got = await answerAt(p, init);
				check(
					`${who}, ${p.replace(g.did, '<did>')} answers as a made-up address in the group does (404, the same body)`,
					got.status === 404 && got.status === like.status && got.text === like.text,
					`${got.status} vs ${like.status}`
				);
			}
		}
		const { alice } = S.pages;
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'in a browser, the members address shows the not-found page, not a roster',
			(await alice.locator('ul[aria-label="Asking to join"]').count()) === 0 &&
				unknown.status === 404
		);
	},
	{ needs: ['people-sign-in', 'alice-makes-groups'] }
);

step('roster', 'todo-approve-again-on-the-members-page', async () => {}, {
	todo: 'an earlier link showing "Approve again" needs a link whose asked scope is out of date and whose grant lacks something (see create/todo-approve-again-for-an-old-link); a link made in this run asks for the current scope'
});

step(
	'roster',
	'alice-links-and-sees-the-roster-controls',
	async (t) => {
		await ensurePublic(S.groups.gj);
		const { alice } = S.pages;
		const g = S.groups.gj;
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await alice.getByRole('button', { name: /^link this group$|^link again$/i }).count()) {
			await alice.getByRole('button', { name: /^link this group$|^link again$/i }).click();
			await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
			await through(alice, ALICE, (u) => u.origin === ATMO);
			await settle(alice);
		}
		// Bob asks with a message, to give the page something to show.
		const { bob } = S.pages;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		S.rosterMessage = `Please let me in, run ${RUN}`;
		await bob.fill('#join-message', S.rosterMessage);
		await bob.getByRole('button', { name: /^ask to join$/i }).click();
		await bob.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'the members page shows who asks, with their message, and Approve and Deny',
			text.includes(S.rosterMessage) &&
				(await alice.getByRole('button', { name: /^approve$/i }).count()) >= 1 &&
				(await alice.getByRole('button', { name: /^deny$/i }).count()) >= 1,
			text.slice(0, 400)
		);
		check(
			'...and Make admin and Remove for the other members',
			(await alice.getByRole('button', { name: /^make admin$/i }).count()) >= 1 &&
				(await alice.getByRole('button', { name: /^remove$/i }).count()) >= 1,
			text.slice(0, 400)
		);
	},
	{
		needs: [
			'founder-cannot-leave-as-the-only-admin',
			'dana-on-the-other-spaces-pds-asks-and-is-admitted'
		]
	}
);

step(
	'roster',
	'approve-bobs-request',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		// A second role the group marks default, written as the group by its admin.
		const admin = await adminFor(g, ALICE);
		let roleWritten = null;
		try {
			await asGroup(
				admin,
				'com.atproto.space.putRecord',
				post({
					space: g.members,
					repo: g.did,
					collection: 'org.atgrp.role',
					rkey: 'walker',
					record: {
						$type: 'org.atgrp.role',
						displayName: 'Walker',
						default: true,
						permissions: []
					}
				})
			);
			roleWritten = true;
		} catch (e) {
			roleWritten = e.message;
		}
		note(`the default role "walker" written as the group: ${roleWritten}`);
		await alice.reload({ waitUntil: 'networkidle' });
		await alice
			.locator('ul[aria-label="Asking to join"] li', { hasText: BOB.handle.split('.')[0] })
			.getByRole('button', { name: /^approve$/i })
			.click();
		await until(
			async () => !(await mainText(alice)).includes(S.rosterMessage),
			(x) => x,
			20,
			500
		);
		t.shot = alice;
		const handleName = BOB.handle.split('.')[0];
		const unconfirmed = (
			await alice
				.locator('ul[aria-label="Not confirmed yet"]')
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		check(
			'alice approves him: he appears, under "Not confirmed yet" until he visits',
			unconfirmed.includes(handleName),
			unconfirmed.slice(0, 300)
		);
		// His visit writes his confirmation.
		await S.pages.bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const members = (await alice.locator('ul[aria-label="Members"]').innerText()).replace(
			/\s+/g,
			' '
		);
		check(
			'after his visit he is on the member list',
			members.includes(handleName),
			members.slice(0, 300)
		);
		check('...and no longer in the requests', !(await mainText(alice)).includes(S.rosterMessage));
		// His row shows each role but member, by its name: member is every row's.
		const bobRow = (
			await alice
				.locator('ul[aria-label="Members"] li', { hasText: handleName })
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		check(
			'approved, he has the roles the group marks default: his row shows the "Walker" role written for it',
			roleWritten === true && bobRow.includes('Walker'),
			bobRow.slice(0, 200)
		);
	},
	{ needs: ['alice-links-and-sees-the-roster-controls'] }
);

step(
	'roster',
	'deny-mallorys-request',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		const asked = await hostCall(MALLORY, 'org.atgrp.requestJoin', {
			group: g.did,
			message: 'Mallory asking'
		});
		check(
			'mallory asks to join (by script)',
			asked.status === 200 && asked.body?.status === 'pending',
			asked.text.slice(0, 120)
		);
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = alice.locator('ul[aria-label="Asking to join"] li', { hasText: 'mallory' });
		check('alice sees the request', (await row.count()) === 1);
		await row.getByRole('button', { name: /^deny$/i }).click();
		await until(
			async () => (await row.count()) === 0,
			(x) => x,
			20,
			500
		);
		t.shot = alice;
		check('denying removes it from the page', (await row.count()) === 0);
		const left = (await joinRequests(await adminFor(g, ALICE))).some(
			(r) => r.member === MALLORY.did
		);
		check('...and at the host', !left);
	},
	{ needs: ['approve-bobs-request'] }
);

step(
	'roster',
	'approving-a-request-already-gone',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		await hostCall(MALLORY, 'org.atgrp.requestJoin', { group: g.did });
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = alice.locator('ul[aria-label="Asking to join"] li', { hasText: 'mallory' });
		check('alice sees mallory asking again', (await row.count()) === 1);
		const gone = await hostCall(MALLORY, 'org.atgrp.cancelJoinRequest', { group: g.did });
		check(
			'mallory withdraws it meanwhile (by script)',
			gone.status === 200,
			gone.text.slice(0, 100)
		);
		await row.getByRole('button', { name: /^approve$/i }).click();
		await alice.getByRole('alert').waitFor({ timeout: 20_000 });
		t.shot = alice;
		const text = await body(alice);
		check(
			'approving it says they are no longer asking',
			/no longer asking to join/i.test(text),
			text.slice(0, 300)
		);
	},
	{ needs: ['deny-mallorys-request'] }
);

step(
	'roster',
	'make-bob-admin-and-back',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = alice.locator('ul[aria-label="Members"] li', { hasText: BOB.handle.split('.')[0] });
		await row.getByRole('button', { name: /^make admin$/i }).click();
		await row.getByRole('button', { name: /^make member$/i }).waitFor({ timeout: 20_000 });
		t.shot = alice;
		check('alice makes bob an admin: his row now offers "Make member"', true);
		await row.getByRole('button', { name: /^make member$/i }).click();
		await row.getByRole('button', { name: /^make admin$/i }).waitFor({ timeout: 20_000 });
		check('and a member again', true);
		await row.getByRole('button', { name: /^make admin$/i }).click();
		await row.getByRole('button', { name: /^make member$/i }).waitFor({ timeout: 20_000 });
	},
	{ needs: ['approve-bobs-request'] }
);

step(
	'roster',
	'two-admins-can-demote-each-other',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		// Bob, an admin now, links the group, and takes alice's admin role away: the group would
		// keep bob. Then taking his own away is not offered. The host's refusal is for the last
		// admin: try to make the only admin a member from a stale page.
		// Alice founded the group at the host, not here, so nothing of hers wrote her confirmation:
		// her group page offers it, and until she confirms, others list her as not confirmed.
		const { alice } = S.pages;
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const confirm = alice.getByRole('button', { name: /^confirm membership$/i });
		if (await confirm.count()) {
			await confirm.click();
			await until(
				async () => (await confirm.count()) === 0,
				(x) => x,
				30,
				500
			);
			check(
				'alice, who founded it at the host, confirms her membership from the group page',
				(await confirm.count()) === 0 && (await confirmationsOf(ALICE, g)).count >= 1
			);
		}
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await bob.getByRole('button', { name: /^link this group$|^link again$/i }).click();
		await bob.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(bob, BOB, (u) => u.origin === ATMO);
		await settle(bob);
		await bob.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const alicesRow = bob.locator('ul[aria-label="Members"] li', {
			hasText: ALICE.handle.split('.')[0]
		});
		check(
			'bob, now an admin who linked it, gets the controls',
			(await alicesRow.getByRole('button', { name: /^make member$/i }).count()) === 1,
			(await mainText(bob)).slice(0, 300)
		);
		await alicesRow.getByRole('button', { name: /^make member$/i }).click();
		await bob.waitForTimeout(3000);
		t.shot = bob;
		const text = await body(bob);
		const demoted = (await alicesRow.getByRole('button', { name: /^make admin$/i }).count()) === 1;
		note(
			`demoting the founder from bob's page: ${demoted ? 'it worked' : 'it did not'}; ${text.slice(0, 300)}`
		);
		if (demoted) {
			// Put her back, as bob, so the steps after this one still have an admin who linked.
			await alicesRow.getByRole('button', { name: /^make admin$/i }).click();
			await alicesRow.getByRole('button', { name: /^make member$/i }).waitFor({ timeout: 20_000 });
		}
		check(
			'with two admins, bob (an admin who linked it) can demote alice, who is put back as admin after',
			demoted && !/leave the group with no admin/i.test(text),
			text.slice(0, 300)
		);
	},
	{ needs: ['make-bob-admin-and-back'] }
);

step(
	'roster',
	'deny-a-request-another-admin-approved',
	async (t) => {
		const { alice, bob } = S.pages;
		const g = S.groups.gj;
		const asked = await hostCall(MALLORY, 'org.atgrp.requestJoin', {
			group: g.did,
			message: 'Mallory, once more'
		});
		check('mallory asks to join (by script)', asked.status === 200, asked.text.slice(0, 120));
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		await bob.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = (page) =>
			page.locator('ul[aria-label="Asking to join"] li', { hasText: 'mallory' });
		check(
			'both admins see her request',
			(await row(alice).count()) === 1 && (await row(bob).count()) === 1
		);
		await row(bob)
			.getByRole('button', { name: /^approve$/i })
			.click();
		await until(
			async () => (await row(bob).count()) === 0,
			(x) => x,
			20,
			500
		);
		await row(alice)
			.getByRole('button', { name: /^deny$/i })
			.click();
		await alice.getByRole('alert').waitFor({ timeout: 20_000 });
		t.shot = alice;
		const text = await body(alice);
		check(
			'bob approves her; alice, on her older page, denies the same request and is told she is no longer asking',
			/no longer asking to join/i.test(text),
			text.slice(0, 300)
		);
	},
	{ needs: ['two-admins-can-demote-each-other'] }
);

step('roster', 'todo-last-admin-sentence', async () => {}, {
	todo: "the no-admin sentence needs an action that would leave the group without an admin; the members page offers no controls on one's own row, and demoting or removing another admin leaves the actor as an admin, so no click reaches it (the unit tests cover the host's LastConfigurer answer)"
});

step(
	'roster',
	'a-plain-member-sees-the-roster-without-controls',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gj;
		// Danas is a plain member, admitted in the join section.
		const { dana } = S.pages;
		await dana.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		t.shot = dana;
		const text = await mainText(dana);
		check(
			'dana, a member who is not an admin, sees the roster',
			(await dana.locator('ul[aria-label="Members"] li').count()) >= 1,
			text.slice(0, 300)
		);
		check(
			'...without Approve, Deny, Make admin, Make member or Remove',
			(await dana
				.getByRole('button', { name: /^(approve|deny|make admin|make member|remove)$/i })
				.count()) === 0
		);
	},
	{ needs: ['two-admins-can-demote-each-other'] }
);

step(
	'roster',
	'remove-a-member',
	async (t) => {
		const { alice, bob } = S.pages;
		const g = S.groups.gj;
		// Alice may have been demoted by the last step: make sure the page still lets her act.
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = alice.locator('ul[aria-label="Members"] li', {
			hasText: DANA.handle.split('.')[0]
		});
		// Bob, an admin too, has the page open from before.
		await bob.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const stale = bob.locator('ul[aria-label="Members"] li', {
			hasText: DANA.handle.split('.')[0]
		});
		await row.getByRole('button', { name: /^remove$/i }).click();
		await until(
			async () => (await row.count()) === 0,
			(x) => x,
			20,
			500
		);
		t.shot = alice;
		check(
			'alice removes dana: she drops off the roster',
			(await row.count()) === 0,
			(await mainText(alice)).slice(0, 300)
		);
		if (await stale.getByRole('button', { name: /^remove$/i }).count()) {
			await stale.getByRole('button', { name: /^remove$/i }).click();
			await bob.waitForTimeout(3000);
			const said = await bob
				.getByRole('alert')
				.allInnerTexts()
				.catch(() => []);
			await bob.reload({ waitUntil: 'networkidle' });
			check(
				'bob, on his older page, removes her again: it ends cleanly, with no failure, and she is not listed',
				!said.some((x) => /did not work|try again/i.test(x)) && (await stale.count()) === 0,
				said.join(' | ') || 'no message'
			);
		} else note("bob's older page did not offer to remove her");
		const { dana } = S.pages;
		await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		check(
			'on her next visit she is not a member',
			(await dana.getByRole('button', { name: /^leave group$/i }).count()) === 0 &&
				(await dana.getByRole('button', { name: /^ask to join$/i }).count()) === 1
		);
		await dana.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		check(
			'and the members page is for members only',
			/only members can see who is in this group/i.test(await mainText(dana))
		);
	},
	{ needs: ['a-plain-member-sees-the-roster-without-controls'] }
);

step(
	'roster',
	'carol-admitted-shows-as-not-confirmed',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gj;
		const asked = await hostCall(CAROL, 'org.atgrp.requestJoin', {
			group: g.did,
			message: 'Carol, no spaces'
		});
		check(
			'carol asks to join (by script: her server has no spaces)',
			asked.status === 200 && asked.body?.status === 'pending',
			asked.text.slice(0, 120)
		);
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		const row = alice.locator('ul[aria-label="Asking to join"] li', { hasText: 'carol' });
		await row.getByRole('button', { name: /^approve$/i }).click();
		await until(
			async () => (await row.count()) === 0,
			(x) => x,
			20,
			500
		);
		t.shot = alice;
		const unconfirmed = (
			await alice
				.locator('ul[aria-label="Not confirmed yet"]')
				.innerText()
				.catch(() => '')
		).replace(/\s+/g, ' ');
		check(
			'admitted, she shows under "Not confirmed yet"',
			unconfirmed.includes('carol'),
			unconfirmed.slice(0, 300)
		);
	},
	{ needs: ['remove-a-member'] }
);

const OLD_GROUP = process.env.WALK_OLD_GROUP?.trim() || '';
step(
	'roster',
	'role-change-through-an-older-link',
	async (t) => {
		const { alice } = S.pages;
		const did = (await (await fetch(`https://${OLD_GROUP}/.well-known/atproto-did`)).text()).trim();
		const g = { did, handle: OLD_GROUP };
		await alice.goto(`${groupUrl(g)}/members`, { waitUntil: 'networkidle' });
		t.shot = alice;
		const row = alice.locator('ul[aria-label="Members"] li', { hasText: BOB.handle.split('.')[0] });
		const [from, to] = (await row.getByRole('button', { name: /^make member$/i }).count())
			? [/^make member$/i, /^make admin$/i]
			: [/^make admin$/i, /^make member$/i];
		check(
			`alice's link to ${OLD_GROUP}, approved before these changes, still offers role changes for bob`,
			(await row.getByRole('button', { name: from }).count()) === 1,
			(await mainText(alice)).slice(0, 300)
		);
		const there = async () => {
			await row.getByRole('button', { name: from }).click();
			await row.getByRole('button', { name: to }).waitFor({ timeout: 20_000 });
		};
		await there();
		check(
			'the role change is made, on the page, with no new approval asked for',
			new URL(alice.url()).origin === ATMO
		);
		// And back.
		await row.getByRole('button', { name: to }).click();
		await row.getByRole('button', { name: from }).waitFor({ timeout: 20_000 });
		check('...and back again', new URL(alice.url()).origin === ATMO);
	},
	{
		needs: ['founder-cannot-leave-as-the-only-admin'],
		todo: OLD_GROUP
			? null
			: 'needs WALK_OLD_GROUP, the handle of a group alice linked before the current app code, with bob in it'
	}
);

// =====================================================================================
// members-only: events only the group's members see, posted from its page into its calendar space
// =====================================================================================
const MO_EVENT = `Moonlit supper ${RUN}`;
const CALENDAR_SPACE = (did) => `at:space/${did}/community.lexicon.calendar.collection/self`;
const moEventUrl = (g, rkey) => `${groupUrl(g)}/events/${rkey}`;
/** Another key of the same shape as `rkey`, for an event that does not exist. */
const madeUpKey = (rkey) => rkey.slice(0, -4) + (rkey.endsWith('zzzz') ? 'yyyy' : 'zzzz');
/** What a page answers at the event's address and at a made-up key: status and main text. */
async function sameAsMadeUp(page, g, rkey) {
	const real = await status(page, moEventUrl(g, rkey));
	const realText = await mainText(page).catch(() => '');
	const fake = await status(page, moEventUrl(g, madeUpKey(rkey)));
	const fakeText = await mainText(page).catch(() => '');
	return { real, fake, realText, fakeText, same: real === fake && realText === fakeText };
}
const moSection = (page) => page.getByRole('heading', { name: /^members-only events$/i, level: 2 });

step(
	'members-only',
	'alice-turns-on-members-only-events',
	async (t) => {
		const { alice } = S.pages;
		const g = await indexedGroup(`me${RUN}`, `Fell runners ${RUN}`);
		S.groups.gm = g;
		if (!g.linkedByAlice) {
			await startLink(alice, g.handle);
			await through(alice, ALICE, (u) => u.origin === ATMO);
			await settle(alice);
			g.linkedByAlice = true;
		}
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		const membersOnly = alice.getByRole('radio', { name: /^members only/i });
		const before = await mainText(alice);
		check(
			'before they are on, the new-event page offers Members only disabled, and says to turn them on from the group page',
			(await membersOnly.isDisabled()) &&
				before.includes("Members-only events aren't turned on for this group"),
			before.slice(0, 300)
		);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const turnOn = alice.getByRole('button', { name: /^turn on members-only events$/i });
		check(
			'the group page, for alice who linked it, offers "Turn on members-only events"',
			(await turnOn.count()) === 1,
			(await mainText(alice)).slice(0, 300)
		);
		await turnOn.click();
		const again = alice.getByRole('button', { name: /^approve once more$/i });
		await again.waitFor({ timeout: 30_000 });
		t.shot = alice;
		check(
			'turned on, the page asks her to approve the link once more, for the calendar it made',
			(await again.count()) === 1 &&
				(await alice.getByTestId('members-only-setup').innerText()).includes(
					'Approve your link once more'
				)
		);
		await alice.reload({ waitUntil: 'networkidle' });
		check(
			'...and still does after a reload (the calendar is there, the link may not post to it yet)',
			(await again.count()) === 1
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'members-only',
	'approve-once-more-at-the-console',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gm;
		let detail = null;
		await alice.getByRole('button', { name: /^approve once more$/i }).click();
		await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
		await through(alice, ALICE, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				detail = (
					(await page
						.locator('main form')
						.first()
						.textContent()
						.catch(() => '')) ?? ''
				).replace(/\s+/g, ' ');
				await page
					.screenshot({ path: shotPath('approve-once-more-at-the-console-approval') })
					.catch(() => {});
			}
		});
		await settle(alice);
		t.shot = alice;
		check(
			'the console asked her to approve, and she is back on the group page',
			detail !== null && new URL(alice.url()).pathname === `/groups/${g.did}`,
			alice.url()
		);
		const [granted = '', withheld = ''] = (detail ?? '').split(/It would not get/i);
		check(
			"this time the grant keeps the calendar space's write too: nothing is withheld",
			/community\.lexicon\.calendar\.collection/.test(granted) && withheld === '',
			(detail ?? '').slice(-600)
		);
		check(
			'the page no longer shows the setup steps',
			(await alice.getByTestId('members-only-setup').count()) === 0
		);
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		check(
			'the new-event page now offers Members only',
			await alice.getByRole('radio', { name: /^members only/i }).isEnabled()
		);
	},
	{ needs: ['alice-turns-on-members-only-events'] }
);

step(
	'members-only',
	'alice-posts-a-members-only-event',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gm;
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		await editorPublish(alice, MO_EVENT, { placement: 'members' });
		await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 60_000 });
		await settle(alice);
		t.shot = alice;
		const at = new URL(alice.url()).pathname;
		S.moRkey = at.split('/').pop();
		check(
			"alice chooses Members only and posts it: she lands on its page at the group's address, not the public one",
			at === `/groups/${g.did}/events/${S.moRkey}`,
			alice.url()
		);
		const note = (
			await alice
				.getByTestId('private-note')
				.innerText()
				.catch(() => '')
		).trim();
		check(
			'the page shows the event, marked private',
			(await mainText(alice)).includes(MO_EVENT) && /^Private event\./.test(note),
			note
		);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const item = alice.getByTestId('members-only-event').filter({ hasText: MO_EVENT });
		check(
			'the group page lists it under "Members-only events", with an Edit link for her',
			(await moSection(alice).count()) === 1 &&
				(await item.count()) === 1 &&
				(await item.locator(`a[href$="/groups/${g.did}/events/${S.moRkey}/edit"]`).count()) === 1
		);
		check(
			'...and not among the public events',
			!(await alice.getByRole('list', { name: 'Edit events' }).count()) ||
				!(await alice.getByRole('list', { name: 'Edit events' }).innerText()).includes(MO_EVENT)
		);
	},
	{ needs: ['approve-once-more-at-the-console'] }
);

step(
	'members-only',
	'nothing-public-shows-it',
	async (t) => {
		const g = S.groups.gm;
		const rkey = S.moRkey;
		const fake = madeUpKey(rkey);
		const records = await repoRecords(g.did, EVENTS);
		check(
			"it is not in the group's public repo, by key or by name",
			!records.some((r) => r.rkey === rkey || r.value?.name === MO_EVENT),
			JSON.stringify(records.map((r) => r.rkey))
		);
		for (const [what, suffix] of [
			['the public event address', ''],
			['its data.json', '/data.json'],
			['its picture card', '/og.png']
		]) {
			const real = await getJson(`${ATMO}/p/${g.did}/e/${rkey}${suffix}`);
			const other = await getJson(`${ATMO}/p/${g.did}/e/${fake}${suffix}`);
			check(
				`${what} answers 404, as at a made-up key, and never names it`,
				real.status === 404 && other.status === 404 && !real.text.includes(MO_EVENT),
				`${real.status} / made-up ${other.status}`
			);
		}
		for (const feed of ['calendar.ics', 'e/calendar']) {
			const r = await getJson(`${ATMO}/p/${g.did}/${feed}`);
			check(
				`the group's calendar feed (${feed}) does not carry it`,
				!r.text.includes(MO_EVENT) && !r.text.includes(rkey),
				`${r.status} ${r.text.slice(0, 120)}`
			);
		}
		const { anon } = S.pages;
		await anon.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = anon;
		check(
			'signed out, the group page shows neither it nor a members-only section',
			!(await mainText(anon)).includes(MO_EVENT) && (await moSection(anon).count()) === 0
		);
		const seen = await sameAsMadeUp(anon, g, rkey);
		check(
			"signed out, the event's address answers the same as a made-up key",
			seen.same && !seen.realText.includes(MO_EVENT),
			`${seen.real} "${seen.realText.slice(0, 120)}" / ${seen.fake} "${seen.fakeText.slice(0, 120)}"`
		);
		note(`signed out, both answer ${seen.real}: ${seen.realText.slice(0, 120)}`);
	},
	{ needs: ['alice-posts-a-members-only-event'] }
);

step(
	'members-only',
	'bob-joins-and-sees-it',
	async (t) => {
		const { alice, bob } = S.pages;
		const g = S.groups.gm;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await bob.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(bob, BOB, /^allow joining groups$/i);
			await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		check(
			'before he is a member, bob sees no members-only section',
			(await moSection(bob).count()) === 0 && !(await mainText(bob)).includes(MO_EVENT)
		);
		await bob.fill('#join-message', `Bob for the supper, run ${RUN}`);
		await bob.getByRole('button', { name: /^ask to join$/i }).click();
		await bob.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		// The members page is held back in this build: the admin admits him at the group host.
		await admitAtHost(await adminFor(g, ALICE), g, BOB.did);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		// A member whose own sign-in can't open members-only events is asked for it here.
		if (await bob.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			note('as a member, his page asked again for what members-only events take');
			await allowOnPage(bob, BOB, /^allow joining groups$/i);
			await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		t.shot = bob;
		const item = bob.getByTestId('members-only-event').filter({ hasText: MO_EVENT });
		check(
			'admitted at the host; as a member he sees it on the group page, marked Members only with a lock',
			(await bob.getByRole('button', { name: /^leave group$/i }).count()) === 1 &&
				(await item.count()) === 1 &&
				/members only/i.test(await item.innerText()) &&
				(await item.locator('svg').count()) >= 1,
			(await mainText(bob)).slice(0, 400)
		);
		check('...without an Edit link', (await item.locator('a[href$="/edit"]').count()) === 0);
		await bob.goto(moEventUrl(g, S.moRkey), { waitUntil: 'networkidle' });
		const noteEl = bob.getByTestId('private-note');
		const sentence = (await noteEl.innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
		check(
			`its own page says exactly "Private event. Only members of ${g.name} can see it." with a lock`,
			sentence === `Private event. Only members of ${g.name} can see it.` &&
				(await noteEl.locator('svg').count()) === 1,
			sentence
		);
		check('...and shows the event', (await mainText(bob)).includes(MO_EVENT));
	},
	{ needs: ['nothing-public-shows-it'] }
);

step(
	'members-only',
	'bob-rsvps-into-his-own-repo',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gm;
		// The calendar's policy, as the group reads it: what members and admins are granted there.
		try {
			const space = await asGroup(
				await adminFor(g, ALICE),
				`com.atproto.space.getSpace?${new URLSearchParams({ space: CALENDAR_SPACE(g.did) })}`,
				{ method: 'GET' }
			);
			note(`the calendar space's policy: ${JSON.stringify(space.policy)}`);
		} catch (e) {
			note(`the calendar space's policy could not be read: ${e.message}`);
		}
		const since = new Date(Date.now() - 1000);
		await bob.getByRole('button', { name: 'Going', exact: true }).click();
		await bob.getByText(/you're going/i).waitFor({ timeout: 20_000 });
		t.shot = bob;
		check('bob answers Going, and the page says so', true);
		const jwt = await pdsSession(BOB);
		const listed = await until(
			() =>
				getJson(
					`${BOB.pds}/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space: CALENDAR_SPACE(g.did), repo: BOB.did, collection: 'community.lexicon.calendar.rsvp' })}`,
					{ headers: { authorization: `Bearer ${jwt}` } }
				),
			(r) => (r.body?.records ?? []).some((x) => x.rkey === S.moRkey),
			20
		);
		const rsvp = (listed.last?.body?.records ?? []).find((x) => x.rkey === S.moRkey);
		check(
			"his RSVP is in his own repo, in the group's calendar space, naming the event, as going",
			Boolean(rsvp) &&
				/#going$/.test(rsvp.value?.status ?? '') &&
				String(rsvp.value?.subject?.uri ?? '').includes(g.did) &&
				String(rsvp.value?.subject?.uri ?? '').includes(S.moRkey),
			`${listed.last?.status} ${JSON.stringify(rsvp ?? listed.last?.text?.slice(0, 200))}`
		);
		const pub = await getJson(
			`${BOB.pds}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: BOB.did, collection: 'community.lexicon.calendar.rsvp' })}`
		);
		check(
			'...and not in his public repo',
			!(pub.body?.records ?? []).some((x) => x.uri?.endsWith(`/${S.moRkey}`)),
			pub.text.slice(0, 200)
		);
		await bob.reload({ waitUntil: 'networkidle' });
		check(
			'after a reload the page still says he is going',
			(await bob.getByText(/you're going/i).count()) === 1
		);
		// What the group host was told of his RSVP, and what it answered.
		const told = hostRequests(since).filter(
			(r) => !/getRecord|getViewer|atproto-did/.test(r.route)
		);
		note(
			`the host since his RSVP: ${told.map((r) => `${r.method} ${r.route} ${r.status}`).join(', ')}`
		);
		const refusals = dockerLogs(GH, since)
			.split('\n')
			.filter(
				(l) =>
					/notifyRepoUpdate|writer|refus|denied|forbidden/i.test(l) && !/"status":2\d\d/.test(l)
			);
		note(
			`host log lines that look like a refusal: ${
				refusals.length
					? refusals
							.slice(0, 3)
							.map((l) => l.slice(0, 400))
							.join(' | ')
					: 'none'
			}`
		);
	},
	{ needs: ['bob-joins-and-sees-it'] }
);

step(
	'members-only',
	'a-second-member-does-not-see-his-rsvp',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gm;
		const dana = S.pages.dana ?? (await signInToAtmo(DANA));
		await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await dana.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(dana, DANA, /^allow joining groups$/i);
			await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		await dana.fill('#join-message', 'Dana for the supper');
		await dana.getByRole('button', { name: /^ask to join$/i }).click();
		await dana.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		await admitAtHost(await adminFor(g, ALICE), g, DANA.did);
		await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await dana.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(dana, DANA, /^allow joining groups$/i);
			await dana.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		check(
			'dana, another member, sees the members-only event on the group page',
			(await dana.getByTestId('members-only-event').filter({ hasText: MO_EVENT }).count()) === 1,
			(await mainText(dana)).slice(0, 300)
		);
		await dana.goto(moEventUrl(g, S.moRkey), { waitUntil: 'networkidle' });
		t.shot = dana;
		const text = await body(dana);
		check(
			"on the event's page nothing shows bob's RSVP: not his handle, nor anyone going",
			text.includes(MO_EVENT) &&
				!text.includes(BOB.handle) &&
				!/\b1\s+going\b|going\s*\(?1\)?\b/i.test(text),
			text.slice(0, 400)
		);
	},
	{ needs: ['bob-rsvps-into-his-own-repo'] }
);

step(
	'members-only',
	'a-public-save-under-its-key-is-refused',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gm;
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = alice;
		// The editor's own command, called from the page as the editor calls it.
		const tryPut = (rkey, placement) =>
			alice.evaluate(
				async ([groupDid, key, where, name]) => {
					const { putGroupEvent } = await import('/src/lib/groups/group.remote.ts');
					const now = new Date();
					const record = {
						$type: 'community.lexicon.calendar.event',
						name,
						createdAt: now.toISOString(),
						startsAt: new Date(now.getTime() + 86_400_000).toISOString()
					};
					try {
						await putGroupEvent({ groupDid, rkey: key, record, placement: where });
						return { ok: true };
					} catch (e) {
						return { ok: false, status: e?.status, message: e?.body?.message ?? String(e) };
					}
				},
				[g.did, rkey, placement, `Public copy ${RUN}`]
			);
		const pub = await tryPut(S.moRkey, 'everyone');
		check(
			"a public save as the group under the members-only event's key is refused (409) in words",
			!pub.ok && pub.status === 409 && /members-only event stays members-only/i.test(pub.message),
			JSON.stringify(pub)
		);
		const records = await repoRecords(g.did, EVENTS);
		check(
			"...and nothing reached the group's public repo under that key",
			!records.some((r) => r.rkey === S.moRkey),
			JSON.stringify(records.map((r) => r.rkey))
		);
		const self = await tryPut('self', 'members');
		check(
			'a members-only save under the key "self" is refused in words',
			!self.ok && self.status === 409 && /cannot be saved under that key/i.test(self.message),
			JSON.stringify(self)
		);
	},
	{ needs: ['alice-posts-a-members-only-event'] }
);

step(
	'members-only',
	'outsider-mallory-gets-not-found',
	async (t) => {
		const g = S.groups.gm;
		const mallory = S.pages.mallory ?? (await signInToAtmo(MALLORY));
		const first = await sameAsMadeUp(mallory, g, S.moRkey);
		note(
			`before she allows joining groups, mallory gets ${first.real} at the event and ${first.fake} at a made-up key: ${first.realText.slice(0, 120)}`
		);
		check(
			'signed in, before she allows joining groups, the event address answers her as a made-up key does',
			first.same && !first.realText.includes(MO_EVENT),
			`${first.real} / ${first.fake}`
		);
		await mallory.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await mallory.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(mallory, MALLORY, /^allow joining groups$/i);
			await mallory.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		t.shot = mallory;
		check(
			'an outsider who may join groups sees no members-only section on the group page',
			(await moSection(mallory).count()) === 0 && !(await mainText(mallory)).includes(MO_EVENT)
		);
		const after = await sameAsMadeUp(mallory, g, S.moRkey);
		check(
			"...and gets 404 at the event's address, the same as at a made-up key",
			after.real === 404 && after.same && !after.realText.includes(MO_EVENT),
			`${after.real} "${after.realText.slice(0, 100)}" / ${after.fake} "${after.fakeText.slice(0, 100)}"`
		);
	},
	{ needs: ['bob-rsvps-into-his-own-repo'] }
);

step(
	'members-only',
	'private-group-member-still-sees-it',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gm;
		await setMetaPublic(await adminFor(g, ALICE), g, false);
		privateNow.add(g.did);
		await reindex(g);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		const item = bob.getByTestId('members-only-event').filter({ hasText: MO_EVENT });
		check(
			'the group is made private altogether at the host; bob, a member, still sees its members-only event',
			(await mainText(bob)).includes(g.name) && (await item.count()) === 1,
			(await mainText(bob)).slice(0, 300)
		);
		await bob.goto(moEventUrl(g, S.moRkey), { waitUntil: 'networkidle' });
		check(
			'...and its page',
			(await mainText(bob)).includes(MO_EVENT) &&
				(await bob.getByTestId('private-note').count()) === 1
		);
		await ensurePublic(g);
	},
	{ needs: ['bob-rsvps-into-his-own-repo'] }
);

step(
	'members-only',
	'carol-is-told-why-she-cannot',
	async (t) => {
		const g = S.groups.gm;
		const carol = S.pages.carol ?? (await signInToAtmo(CAROL));
		const first = await sameAsMadeUp(carol, g, S.moRkey);
		check(
			"carol (a PDS without spaces) gets the same page at the event's address as at a made-up key, without the event",
			first.same && !first.realText.includes(MO_EVENT),
			`${first.real} / ${first.fake}: ${first.realText.slice(0, 160)}`
		);
		// Her server's answer is told on the page it returns her to.
		await carol.goto(moEventUrl(g, S.moRkey), { waitUntil: 'networkidle' });
		const asked =
			(await carol.getByRole('button', { name: /^allow joining groups$/i }).count()) > 0;
		if (asked) await allowOnPage(carol, CAROL, /^allow joining groups$/i);
		t.shot = carol;
		const text = await mainText(carol);
		check(
			'asked to allow joining groups, back from her server she is told it gave no permission, and where spaces are',
			asked &&
				/did not give atmo permission to act for you in groups/i.test(text) &&
				text.includes(new URL(ALPHA).host),
			text.slice(0, 300)
		);
		check('...and is not shown the event', !text.includes(MO_EVENT));
	},
	{ needs: ['alice-posts-a-members-only-event'] }
);

step(
	'members-only',
	'bob-leaves-and-it-is-gone',
	async (t) => {
		await ensurePublic(S.groups.gm);
		const { bob } = S.pages;
		const g = S.groups.gm;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		await bob.getByRole('button', { name: /^leave group$/i }).click();
		await bob.getByRole('button', { name: /^ask to join$/i }).waitFor({ timeout: 20_000 });
		await bob.reload({ waitUntil: 'networkidle' });
		t.shot = bob;
		check(
			'bob leaves: on his next visit the members-only section and the event are gone',
			(await moSection(bob).count()) === 0 && !(await mainText(bob)).includes(MO_EVENT),
			(await mainText(bob)).slice(0, 300)
		);
		const seen = await sameAsMadeUp(bob, g, S.moRkey);
		check(
			'...and its address is a 404 for him, the same as a made-up key',
			seen.real === 404 && seen.same && !seen.realText.includes(MO_EVENT),
			`${seen.real} / ${seen.fake}: ${seen.realText.slice(0, 120)}`
		);
	},
	{ needs: ['outsider-mallory-gets-not-found', 'private-group-member-still-sees-it'] }
);

// ---------- a calendar another app made the group first, reused ----------
// "Another app" is a second loopback OAuth client of the walk's, signed in as the group by alice,
// with only calendar-space scopes: it makes the group a calendar space keyed `wiki` before atmo
// turns members-only events on, and writes three records there.
const CAL_TYPE = 'community.lexicon.calendar.collection';
const OTHER_COLLECTION = 'org.example.wiki.page';
const OTHER_APP_SCOPE = [
	'atproto',
	`space:${CAL_TYPE}?authority=self&manage=create`,
	`space:${CAL_TYPE}?authority=self&collection=${EVENTS}&collection=${OTHER_COLLECTION}&action=read&action=create&action=update&action=delete`
].join(' ');
const calendarAt = (did, skey) => `at:space/${did}/${CAL_TYPE}/${skey}`;
/** The policy the other app gives its calendar: private; admins post events as the group; members
 *  read it. And, so the other app can write its own kind of record there, that collection too. */
const WIKI_POLICY = {
	$type: 'org.atgrp.policy',
	publicRead: false,
	grants: [
		{
			role: 'admin',
			permissions: [
				`space:${CAL_TYPE}?collection=${EVENTS}`,
				`space:${CAL_TYPE}?collection=${OTHER_COLLECTION}`
			]
		},
		{ role: 'member', read: true }
	]
};
/** A calendar its members read where no role may post events. */
const NO_POSTING_POLICY = {
	$type: 'org.atgrp.policy',
	publicRead: false,
	grants: [
		{ role: 'admin', read: true },
		{ role: 'member', read: true }
	]
};
const WIKI_EVENT = `Wiki moor walk ${RUN}`;
const WIKI_BROKEN = `Wiki notes without a start ${RUN}`;
const WIKI_OWN_EVENT = `Lantern supper ${RUN}`;
/** As the other app: the group's calendar space `space`, or the error the host gave (SpaceNotFound
 *  for one it does not have). */
async function spaceAsOtherApp(session, space) {
	try {
		const r = await asGroup(
			session,
			`com.atproto.space.getSpace?${new URLSearchParams({ space })}`,
			{ method: 'GET' }
		);
		return { policy: r.policy };
	} catch (e) {
		return { error: e.message };
	}
}
const otherAppPage = async () => S.pages['alice-other-app'] ?? (await pageFor('alice-other-app'));
/** The group page's "Turn on members-only events", pressed; then what the page shows. */
async function pressTurnOn(page, g) {
	await page.goto(groupUrl(g), { waitUntil: 'networkidle' });
	const turnOn = page.getByRole('button', { name: /^turn on members-only events$/i });
	const offered = (await turnOn.count()) === 1;
	if (offered) {
		await turnOn.click();
		await page
			.getByRole('alert')
			.or(page.getByRole('button', { name: /^approve once more$/i }))
			.or(page.getByTestId('members-only-setup'))
			.first()
			.waitFor({ timeout: 30_000 })
			.catch(() => {});
		await settle(page);
		await sleep(1000);
	}
	const alert = (
		await page
			.getByRole('alert')
			.allInnerTexts()
			.catch(() => [])
	).join(' ');
	return { offered, alert };
}

step(
	'members-only',
	'another-app-makes-a-wiki-calendar',
	async (t) => {
		const g = await indexedGroup(`wk${RUN}`, `Wiki walkers ${RUN}`);
		S.groups.gw = g;
		const page = await otherAppPage();
		t.shot = page;
		const maker = await signInAsGroup(page, ALICE, g, OTHER_APP_SCOPE);
		const made = await asGroup(
			maker,
			'com.atproto.space.createSpace',
			post({ spaceType: CAL_TYPE, skey: 'wiki', policy: WIKI_POLICY })
		);
		check(
			'another app, signed in as the group with calendar scopes only, makes it a calendar space keyed "wiki" (createSpace)',
			made.space === calendarAt(g.did, 'wiki'),
			JSON.stringify(made)
		);
		// The host grants a link a calendar's record writes only for one that is there at the
		// approval: the other app is approved once more, now that it is.
		const writer = await signInAsGroup(page, ALICE, g, OTHER_APP_SCOPE);
		S.otherApp = writer;
		const put = (collection, rkey, record) =>
			asGroup(
				writer,
				'com.atproto.space.putRecord',
				post({ space: calendarAt(g.did, 'wiki'), repo: g.did, collection, rkey, record })
			)
				.then(() => 'taken')
				.catch((e) => e.message);
		const now = Date.now();
		const keys = { valid: tid(), noStart: tid(), other: tid() };
		S.wikiKeys = keys;
		const answers = {
			valid: await put(EVENTS, keys.valid, {
				$type: EVENTS,
				name: WIKI_EVENT,
				createdAt: new Date(now).toISOString(),
				startsAt: new Date(now + 3 * 86_400_000).toISOString()
			}),
			noStart: await put(EVENTS, keys.noStart, {
				$type: EVENTS,
				name: WIKI_BROKEN,
				createdAt: new Date(now).toISOString()
			}),
			other: await put(OTHER_COLLECTION, keys.other, {
				$type: OTHER_COLLECTION,
				title: `Wiki page ${RUN}`,
				createdAt: new Date(now).toISOString()
			})
		};
		note(`the other app's writes in the wiki calendar: ${JSON.stringify(answers)}`);
		check(
			'...and writes one valid event, one event without startsAt, and one record of another collection there',
			Object.values(answers).every((a) => a === 'taken'),
			JSON.stringify(answers)
		);
		const wiki = await spaceAsOtherApp(writer, calendarAt(g.did, 'wiki'));
		S.wikiPolicy = wiki.policy;
		note(`the wiki calendar's policy at the host: ${JSON.stringify(wiki.policy ?? wiki.error)}`);
		const self = await spaceAsOtherApp(writer, calendarAt(g.did, 'self'));
		check(
			'the group has no calendar keyed "self"',
			/SpaceNotFound/.test(self.error ?? ''),
			JSON.stringify(self)
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'members-only',
	'turning-on-uses-the-wiki-calendar',
	async (t) => {
		const g = S.groups.gw;
		// Alice links the group now, after the wiki calendar was made: an admin's fresh approval.
		let asked = '';
		let members = null;
		await startLink(S.pages.alice, g.handle);
		await through(S.pages.alice, ALICE, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				members = await membersSpaceAccess(page);
				asked = (
					(await page
						.locator('pre.scopes')
						.first()
						.textContent()
						.catch(() => '')) ?? ''
				).trim();
			}
		});
		g.linkedByAlice = true;
		check(
			"alice's fresh approval as an admin keeps the read of the group's space index",
			onlyTheSpaceIndexRead(asked, members),
			`${asked} / ${JSON.stringify(members)}`
		);
		// Turned on from a sign-in of alice's own that has not granted the join permissions (a new
		// one, in a browser of its own), so only the link can read which calendars the group has.
		const alice = S.pages['alice-own'] ?? (await signInToAtmo(ALICE, 'alice-own'));
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = alice;
		const notGranted =
			(await alice.getByRole('button', { name: /^allow joining groups$/i }).count()) > 0;
		note(
			`alice's own new sign-in ${notGranted ? 'is offered "Allow joining groups" on the page (it has not granted the join permissions)' : 'is not offered "Allow joining groups"'}`
		);
		check(
			'alice\'s own new sign-in has not granted the join permissions: the page offers "Allow joining groups"',
			notGranted,
			(await mainText(alice)).slice(0, 300)
		);
		const before = await mainText(alice);
		check(
			'linked, the group page offers "Turn on members-only events" (atmo has chosen no calendar yet)',
			(await alice.getByRole('button', { name: /^turn on members-only events$/i }).count()) === 1,
			before.slice(0, 400)
		);
		const pressed = await pressTurnOn(alice, g);
		t.shot = alice;
		note(`after turning on, alerts: ${pressed.alert || 'none'}`);
		const setup = alice.getByTestId('members-only-setup');
		const again = alice.getByRole('button', { name: /^approve once more$/i });
		const ready = (await again.count()) === 1 || (await setup.count()) === 0;
		check(
			'turned on through the link alone, without a refusal: the page asks to approve once more, or the link may post at once',
			pressed.offered && !pressed.alert && ready,
			`${pressed.alert} ${(await mainText(alice)).slice(0, 300)}`
		);
		if ((await again.count()) === 1) {
			await again.click();
			await alice.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
			await through(alice, ALICE, (u) => u.origin === ATMO);
			await settle(alice);
			note('the page asked alice to approve her link once more, and she did');
		} else note('her link, approved after the wiki calendar was there, could post to it at once');
		const self = await spaceAsOtherApp(S.otherApp, calendarAt(g.did, 'self'));
		check(
			'no calendar keyed "self" was made at the host',
			/SpaceNotFound/.test(self.error ?? ''),
			JSON.stringify(self)
		);
		const wiki = await spaceAsOtherApp(S.otherApp, calendarAt(g.did, 'wiki'));
		check(
			"the wiki calendar's policy is as the other app left it",
			JSON.stringify(wiki.policy) === JSON.stringify(S.wikiPolicy) && Boolean(wiki.policy),
			`${JSON.stringify(wiki.policy)} vs ${JSON.stringify(S.wikiPolicy)}`
		);
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		check(
			'the new-event page offers Members only',
			await alice.getByRole('radio', { name: /^members only/i }).isEnabled(),
			(await mainText(alice)).slice(0, 300)
		);
	},
	{ needs: ['another-app-makes-a-wiki-calendar'] }
);

step(
	'members-only',
	'alice-posts-into-the-wiki-calendar',
	async (t) => {
		const { alice } = S.pages;
		const g = S.groups.gw;
		await alice.goto(`${groupUrl(g)}/events/new`, { waitUntil: 'networkidle' });
		await editorPublish(alice, WIKI_OWN_EVENT, { placement: 'members' });
		await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 60_000 });
		await settle(alice);
		t.shot = alice;
		const at = new URL(alice.url()).pathname;
		S.wikiOwnKey = at.split('/').pop();
		check(
			"alice posts a members-only event and lands on its page at the group's address",
			at === `/groups/${g.did}/events/${S.wikiOwnKey}` &&
				(await mainText(alice)).includes(WIKI_OWN_EVENT),
			alice.url()
		);
		const self = await spaceAsOtherApp(S.otherApp, calendarAt(g.did, 'self'));
		check(
			'there is still no "self" calendar, so it went to the wiki one (its RSVP, next, names that space)',
			/SpaceNotFound/.test(self.error ?? ''),
			JSON.stringify(self)
		);
		const puts = hostRequests(new Date(Date.now() - 90_000)).filter((r) =>
			r.route.endsWith('com.atproto.space.putRecord')
		);
		note(`the host's putRecord answers in the last 90 s: ${puts.map((r) => r.status).join(' ')}`);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const listed = await alice.getByTestId('members-only-event').allInnerTexts();
		check(
			"the group page lists hers and the other app's valid event under Members-only events, not the one without a start",
			listed.some((x) => x.includes(WIKI_OWN_EVENT)) &&
				listed.some((x) => x.includes(WIKI_EVENT)) &&
				!(await mainText(alice)).includes(WIKI_BROKEN),
			listed.join(' | ').slice(0, 300)
		);
	},
	{ needs: ['turning-on-uses-the-wiki-calendar'] }
);

step(
	'members-only',
	'a-member-sees-the-wiki-events-and-rsvps-there',
	async (t) => {
		const { bob } = S.pages;
		const g = S.groups.gw;
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await bob.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(bob, BOB, /^allow joining groups$/i);
			await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		await bob.fill('#join-message', `Bob for the wiki walk, run ${RUN}`);
		await bob.getByRole('button', { name: /^ask to join$/i }).click();
		await bob.getByText(/request sent/i).waitFor({ timeout: 20_000 });
		await admitAtHost(await adminFor(g, ALICE), g, BOB.did);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await bob.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(bob, BOB, /^allow joining groups$/i);
			await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		}
		t.shot = bob;
		const listed = await bob.getByTestId('members-only-event').allInnerTexts();
		check(
			"admitted at the host, bob sees both valid events (alice's and the other app's), each marked Members only",
			listed.some((x) => x.includes(WIKI_OWN_EVENT)) &&
				listed.some((x) => x.includes(WIKI_EVENT)) &&
				listed.every((x) => /members\s*only/i.test(x)),
			`${listed.join(' | ').slice(0, 300)} / ${(await mainText(bob)).slice(0, 200)}`
		);
		check(
			'...and not the record without a start, nor the other collection',
			!(await mainText(bob)).includes(WIKI_BROKEN) &&
				!(await mainText(bob)).includes(`Wiki page ${RUN}`)
		);
		await bob.goto(moEventUrl(g, S.wikiKeys.valid), { waitUntil: 'networkidle' });
		check(
			"the other app's event opens on its own page for him",
			(await mainText(bob)).includes(WIKI_EVENT)
		);
		for (const [what, key] of [
			['the record without a start', S.wikiKeys.noStart],
			["the other collection's record", S.wikiKeys.other]
		]) {
			const seen = await sameAsMadeUp(bob, g, key);
			check(
				`for him, ${what}'s key answers as a made-up key does`,
				seen.same && !seen.realText.includes(WIKI_BROKEN),
				`${seen.real} / ${seen.fake}`
			);
		}
		await bob.goto(moEventUrl(g, S.wikiOwnKey), { waitUntil: 'networkidle' });
		await bob.getByRole('button', { name: 'Going', exact: true }).click();
		await bob.getByText(/you're going/i).waitFor({ timeout: 20_000 });
		const jwt = await pdsSession(BOB);
		const inSpace = (skey) =>
			getJson(
				`${BOB.pds}/xrpc/com.atproto.space.listRecords?${new URLSearchParams({ space: calendarAt(g.did, skey), repo: BOB.did, collection: 'community.lexicon.calendar.rsvp' })}`,
				{ headers: { authorization: `Bearer ${jwt}` } }
			);
		const listedRsvps = await until(
			() => inSpace('wiki'),
			(r) => (r.body?.records ?? []).some((x) => x.rkey === S.wikiOwnKey),
			20
		);
		const rsvp = (listedRsvps.last?.body?.records ?? []).find((x) => x.rkey === S.wikiOwnKey);
		const subject = String(rsvp?.value?.subject?.uri ?? '');
		note(`his RSVP names ${subject}`);
		check(
			"he answers Going to alice's event: his RSVP is in his own repo in the group's wiki calendar space, naming the event there",
			Boolean(rsvp) &&
				/#going$/.test(rsvp.value?.status ?? '') &&
				subject.includes(`${CAL_TYPE}/wiki`) &&
				subject.endsWith(`/${S.wikiOwnKey}`),
			`${listedRsvps.last?.status} ${JSON.stringify(rsvp ?? listedRsvps.last?.text?.slice(0, 200))}`
		);
		const self = await inSpace('self');
		check(
			'...and none in a "self" calendar',
			!(self.body?.records ?? []).length,
			`${self.status} ${self.text.slice(0, 120)}`
		);
		t.shot = bob;
	},
	{ needs: ['alice-posts-into-the-wiki-calendar'] }
);

/** From a page of atmo: the group page's own command to turn members-only events on, called as the
 *  page calls it. Its answer: ok, or the status and message it was refused with. */
const callTurnOn = (page, g) =>
	page.evaluate(async (groupDid) => {
		const { turnOnMembersOnlyEvents } = await import('/src/lib/groups/group.remote.ts');
		try {
			await turnOnMembersOnlyEvents({ groupDid });
			return { ok: true };
		} catch (e) {
			return { ok: false, status: e?.status, message: e?.body?.message ?? String(e) };
		}
	}, g.did);

step(
	'members-only',
	'a-member-who-links-may-not-turn-it-on',
	async (t) => {
		const { bob, alice } = S.pages;
		const g = S.groups.gw;
		await startLink(bob, g.handle);
		await through(bob, BOB, (u) => u.origin === ATMO);
		await settle(bob);
		await bob.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = bob;
		check(
			'bob, a plain member, links the group: his page offers no "Turn on members-only events"',
			(await bob.getByRole('button', { name: /^turn on members-only events$/i }).count()) === 0,
			(await mainText(bob)).slice(0, 300)
		);
		const answer = await callTurnOn(bob, g);
		note(`the command, called from his page, answered ${JSON.stringify(answer)}`);
		check(
			"calling the page's command anyway is refused (403): his role doesn't let him turn them on",
			!answer.ok &&
				answer.status === 403 &&
				/doesn't let you turn on members-only events/i.test(answer.message ?? ''),
			JSON.stringify(answer)
		);
		const self = await spaceAsOtherApp(S.otherApp, calendarAt(g.did, 'self'));
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		const listed = await alice.getByTestId('members-only-event').allInnerTexts();
		check(
			'the group\'s calendar choice is unchanged: no "self" calendar, and the group page still lists the wiki calendar\'s events',
			/SpaceNotFound/.test(self.error ?? '') &&
				listed.some((x) => x.includes(WIKI_OWN_EVENT)) &&
				listed.some((x) => x.includes(WIKI_EVENT)),
			`${JSON.stringify(self)} ${listed.join(' | ').slice(0, 200)}`
		);
	},
	{ needs: ['a-member-sees-the-wiki-events-and-rsvps-there'] }
);

step(
	'members-only',
	'an-outsider-gets-not-found-for-every-wiki-key',
	async (t) => {
		const g = S.groups.gw;
		const mallory = S.pages.mallory ?? (await signInToAtmo(MALLORY));
		await mallory.goto(groupUrl(g), { waitUntil: 'networkidle' });
		if (await mallory.getByRole('button', { name: /^allow joining groups$/i }).count()) {
			await allowOnPage(mallory, MALLORY, /^allow joining groups$/i);
		}
		const madeUp = madeUpKey(S.wikiKeys.valid);
		const fake = await status(mallory, moEventUrl(g, madeUp));
		const fakeText = await mainText(mallory).catch(() => '');
		t.shot = mallory;
		const seen = {};
		for (const [what, key] of [
			["alice's event", S.wikiOwnKey],
			["the other app's event", S.wikiKeys.valid],
			['the record without a start', S.wikiKeys.noStart],
			["the other collection's record", S.wikiKeys.other]
		]) {
			const real = await status(mallory, moEventUrl(g, key));
			const text = await mainText(mallory).catch(() => '');
			seen[what] = real;
			check(
				`mallory, not a member, gets for ${what}'s key what a made-up key gives (${fake})`,
				real === fake &&
					text === fakeText &&
					!text.includes(WIKI_EVENT) &&
					!text.includes(WIKI_OWN_EVENT) &&
					!text.includes(WIKI_BROKEN),
				`${real} "${text.slice(0, 100)}" / ${fake} "${fakeText.slice(0, 100)}"`
			);
		}
		note(`made-up key ${fake}; ${JSON.stringify(seen)}`);
	},
	{ needs: ['a-member-sees-the-wiki-events-and-rsvps-there'] }
);

step(
	'members-only',
	'refused-when-no-role-may-post-to-its-calendar',
	async (t) => {
		const { alice } = S.pages;
		const g = await indexedGroup(`nr${RUN}`, `Notes keepers ${RUN}`);
		S.groups.gn = g;
		const maker = await signInAsGroup(await otherAppPage(), ALICE, g, OTHER_APP_SCOPE);
		const made = await asGroup(
			maker,
			'com.atproto.space.createSpace',
			post({ spaceType: CAL_TYPE, skey: 'notes', policy: NO_POSTING_POLICY })
		);
		const kept = (await spaceAsOtherApp(maker, made.space)).policy;
		check(
			'another app gives a fresh group a calendar keyed "notes" that its members read and no role may post to',
			made.space === calendarAt(g.did, 'notes'),
			JSON.stringify(made)
		);
		await reindex(g);
		const pressed = await pressTurnOn(alice, g);
		t.shot = alice;
		note(`alice pressed "Turn on members-only events": ${pressed.alert || 'no alert'}`);
		check(
			'turning on is refused, saying an admin can allow it at the group host and no second calendar was made',
			pressed.offered &&
				/already has a calendar for its members/i.test(pressed.alert) &&
				/an admin can allow it at the group host/i.test(pressed.alert) &&
				/made no second one/i.test(pressed.alert),
			pressed.alert || (await mainText(alice)).slice(0, 300)
		);
		const self = await spaceAsOtherApp(maker, calendarAt(g.did, 'self'));
		check(
			'no calendar keyed "self" was made',
			/SpaceNotFound/.test(self.error ?? ''),
			JSON.stringify(self)
		);
		const after = (await spaceAsOtherApp(maker, made.space)).policy;
		check(
			'and the "notes" calendar\'s policy is unchanged',
			JSON.stringify(after) === JSON.stringify(kept) && Boolean(kept),
			`${JSON.stringify(after)} vs ${JSON.stringify(kept)}`
		);
		await alice.reload({ waitUntil: 'networkidle' });
		const text = await mainText(alice);
		check(
			'after a reload the page says the calendar was not set up for atmo to post to, and offers no Turn on',
			/wasn.t set up for atmo to post members-only events to/i.test(text) &&
				(await alice.getByRole('button', { name: /^turn on members-only events$/i }).count()) === 0,
			text.slice(0, 400)
		);
	},
	{ needs: ['people-sign-in'] }
);

step(
	'members-only',
	'refused-when-its-self-calendar-is-public',
	async (t) => {
		const { alice } = S.pages;
		const g = await indexedGroup(`pc${RUN}`, `Open calendar keepers ${RUN}`);
		const maker = await signInAsGroup(await otherAppPage(), ALICE, g, OTHER_APP_SCOPE);
		const made = await asGroup(
			maker,
			'com.atproto.space.createSpace',
			post({ spaceType: CAL_TYPE, skey: 'self', policy: { ...WIKI_POLICY, publicRead: true } })
		);
		check(
			'another app gives a fresh group a calendar keyed "self" that anyone may read',
			made.space === calendarAt(g.did, 'self'),
			JSON.stringify(made)
		);
		await reindex(g);
		await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
		t.shot = alice;
		const text = await mainText(alice);
		check(
			'the group page, for alice who linked it, says its calendar can be read by more than its members, and offers no Turn on',
			/can be read by more than its members/i.test(text) &&
				(await alice.getByRole('button', { name: /^turn on members-only events$/i }).count()) === 0,
			text.slice(0, 400)
		);
		const answer = await callTurnOn(alice, g);
		note(`the command, called from her page, answered ${JSON.stringify(answer)}`);
		check(
			'calling the command anyway is refused (409) with its message, that atmo will not use a calendar the public can read',
			!answer.ok &&
				answer.status === 409 &&
				/can be read by more than its members, so atmo won't use it for members-only events/i.test(
					answer.message ?? ''
				),
			JSON.stringify(answer)
		);
		const after = await spaceAsOtherApp(maker, made.space);
		check(
			'...and the calendar is as it was: still public',
			after.policy?.publicRead === true,
			JSON.stringify(after)
		);
	},
	{ needs: ['people-sign-in'] }
);

// =====================================================================================
// private-events: the app's own private events (not groups) on this network's PDS, on a dev server
// started with PRIVATE_EVENTS=true; skipped otherwise
// =====================================================================================
const PE_OFF = process.env.WALK_PRIVATE_EVENTS
	? null
	: 'needs a dev server started with PRIVATE_EVENTS=true; set WALK_PRIVATE_EVENTS=1 to run it';
const PE_EVENT = `Hidden supper ${RUN}`;
/** atmo's own log lines since byte `from` that tell of a failed call. */
const failedLines = (from) =>
	atmoLogSince(from)
		.split('\n')
		.filter((l) => /\b(4\d\d|5\d\d)\b|error|refus|invalid/i.test(l) && !/ingest\] cycle/.test(l))
		.slice(0, 12)
		.map((l) => l.slice(0, 400));
/** From a page of atmo: press the button, go through the PDS's consent, and come back. */
async function consentFrom(page, who, button) {
	await button.click();
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30_000 });
	await through(page, who, (u) => u.origin === ATMO);
	await settle(page);
}

step(
	'private-events',
	'alice-turns-on-the-beta',
	async (t) => {
		const { alice } = S.pages;
		await alice.goto(`${ATMO}/settings`, { waitUntil: 'networkidle' });
		const section = alice.getByTestId('private-events-beta');
		await section.waitFor({ timeout: 20_000 });
		const authorize = section.getByRole('button', { name: /^authorize now$/i });
		if (await authorize.isVisible().catch(() => false)) {
			await consentFrom(alice, ALICE, authorize);
			await alice.goto(`${ATMO}/settings`, { waitUntil: 'networkidle' });
		}
		await section.getByText(/try private events/i).click({ timeout: 20_000 });
		await section.getByRole('button', { name: /^save$/i }).click();
		await section.getByText('Saved.').waitFor({ timeout: 20_000 });
		t.shot = alice;
		const saved = await getJson(
			`${ALICE.pds}/xrpc/com.atproto.repo.getRecord?${new URLSearchParams({ repo: ALICE.did, collection: 'rsvp.atmo.actor.privateEventsBeta', rkey: 'self' })}`
		);
		check(
			'alice turns on the private events beta in Settings: a record in her own repo',
			saved.status === 200 && saved.body?.value?.privateEvents === true,
			`${saved.status} ${saved.text.slice(0, 200)}`
		);
	},
	{ needs: ['people-sign-in'], todo: PE_OFF }
);

step(
	'private-events',
	'alice-makes-a-private-event',
	async (t) => {
		const { alice } = S.pages;
		const from = atmoLogSize();
		await alice.goto(`${ATMO}/create`, { waitUntil: 'networkidle' });
		const ask = alice
			.getByTestId('ask-first')
			.getByRole('button', { name: /^allow private events$/i });
		if (await ask.isVisible().catch(() => false)) {
			await consentFrom(alice, ALICE, ask);
			await alice.goto(`${ATMO}/create`, { waitUntil: 'networkidle' });
		}
		const field = alice.locator('main [contenteditable=true]').first();
		await field.waitFor({ timeout: 60_000 });
		const privateChoice = alice
			.getByRole('radio', { name: 'Private', exact: true })
			.or(alice.getByRole('button', { name: 'Private', exact: true }));
		await privateChoice.first().click();
		const modal = alice.getByRole('dialog', { name: /make this event private/i });
		await modal.waitFor({ timeout: 15_000 });
		const hostAsk = modal.getByRole('button', { name: /^allow atmo to host private events$/i });
		if (await hostAsk.isVisible().catch(() => false)) {
			await consentFrom(alice, ALICE, hostAsk);
			await field.waitFor({ timeout: 60_000 });
			await privateChoice.first().click();
			await modal.waitFor({ timeout: 15_000 });
		}
		await modal.getByRole('button', { name: /^make it private$/i }).click();
		await field.click();
		await alice.keyboard.type(PE_EVENT);
		await alice.getByRole('button', { name: /^start date/i }).click();
		await alice.keyboard.press('ArrowRight');
		await alice.keyboard.press('Enter');
		await alice.getByRole('button', { name: /^publish/i }).click();
		const landed = await alice
			.waitForURL((u) => /\/private\/[^/]+$/.test(u.pathname), { timeout: 60_000 })
			.then(() => true)
			.catch(() => false);
		await settle(alice);
		t.shot = alice;
		const alerts = await alice
			.getByRole('alert')
			.allInnerTexts()
			.catch(() => []);
		const failed = failedLines(from);
		note(`alerts on the page: ${alerts.join(' | ') || 'none'}`);
		note(`atmo's log, failures since the step began: ${failed.join(' || ') || 'none'}`);
		S.pePath = landed ? new URL(alice.url()).pathname : null;
		check(
			'alice publishes a private event and lands on its page',
			landed && (await mainText(alice)).includes(PE_EVENT),
			alice.url()
		);
	},
	{ needs: ['alice-turns-on-the-beta'], todo: PE_OFF }
);

step(
	'private-events',
	'alice-opens-it-and-invites-bob',
	async (t) => {
		const { alice } = S.pages;
		const from = atmoLogSize();
		await alice.goto(`${ATMO}${S.pePath}`, { waitUntil: 'networkidle' });
		t.shot = alice;
		check(
			'opened again, the page shows her private event',
			(await mainText(alice)).includes(PE_EVENT)
		);
		await alice.locator('input[name=guest-handle]').fill(BOB.handle);
		await alice.locator('[data-testid=guest-list] form button[type=submit]').click();
		const added = await alice
			.locator(`[data-guest="${BOB.did}"]`)
			.waitFor({ timeout: 20_000 })
			.then(() => true)
			.catch(() => false);
		note(`atmo's log, failures since the step began: ${failedLines(from).join(' || ') || 'none'}`);
		check(
			'she adds bob by handle, and he is on the guest list',
			added,
			(
				await alice
					.getByTestId('guest-list')
					.innerText()
					.catch(() => '')
			).slice(0, 300)
		);
	},
	{ needs: ['alice-makes-a-private-event'], todo: PE_OFF }
);

step(
	'private-events',
	'bob-opens-it-and-rsvps',
	async (t) => {
		const { bob } = S.pages;
		const from = atmoLogSize();
		await bob.goto(`${ATMO}${S.pePath}`, { waitUntil: 'networkidle' });
		for (const name of [/^allow/i, /^authorize/i]) {
			const allow = bob.locator('main').getByRole('button', { name }).first();
			if (await allow.isVisible().catch(() => false)) {
				await consentFrom(bob, BOB, allow);
				await bob.goto(`${ATMO}${S.pePath}`, { waitUntil: 'networkidle' });
				break;
			}
		}
		t.shot = bob;
		const seen = (await mainText(bob)).includes(PE_EVENT);
		check('bob, invited, sees the event', seen, (await mainText(bob)).slice(0, 300));
		if (seen) {
			await bob.getByRole('button', { name: 'Going', exact: true }).click();
			const going = await bob
				.getByText(/you're going/i)
				.waitFor({ timeout: 20_000 })
				.then(() => true)
				.catch(() => false);
			await bob.reload({ waitUntil: 'networkidle' });
			check(
				'he answers Going, and after a reload it still says so',
				going && (await bob.getByText(/you're going/i).count()) === 1
			);
		}
		note(`atmo's log, failures since the step began: ${failedLines(from).join(' || ') || 'none'}`);
	},
	{ needs: ['alice-opens-it-and-invites-bob'], todo: PE_OFF }
);

// =====================================================================================
// flags: what atmo answers with groups on (the off state needs a server started without the host)
// =====================================================================================
step(
	'flags',
	'index-endpoints-answer',
	async () => {
		const g = await indexedGroup(`fl${RUN}`, `Fell flags ${RUN}`);
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
		const personScopes = String(JSON.parse(meta.text || '{}').scope ?? '').split(' ');
		const groupMeta = await anon('GET', '/oauth/group/client-metadata.json');
		const groupScopes = String(JSON.parse(groupMeta.text || '{}').scope ?? '').split(' ');
		// The group client's are the group's own (authority=self); a person reads any group's meta
		// space and keeps their own confirmation in any group's members space (authority=*).
		const GROUP_CLIENT_ONLY =
			/^(repo\?collection=org\.atgrp\.declaration|space:org\.atgrp\.(meta|members)\?authority=self|rpc:org\.atgrp\.(listJoinRequests|denyJoinRequest))/;
		const PERSON_ONLY =
			/^(rpc:org\.atgrp\.internal\.(createGroup|getActorGroups)|rpc\?lxm=org\.atgrp\.requestJoin|space:org\.atgrp\.(meta|members)\?authority=\*|include:org\.atgrp\.authParticipate)/;
		check(
			"a person's client metadata asks for none of the group client's scopes",
			meta.status === 200 && !personScopes.some((x) => GROUP_CLIENT_ONLY.test(x)),
			personScopes.filter((x) => GROUP_CLIENT_ONLY.test(x)).join(' ')
		);
		check(
			"the group client's metadata asks for none of the person-only scopes",
			groupMeta.status === 200 &&
				groupScopes.length > 1 &&
				!groupScopes.some((x) => PERSON_ONLY.test(x)),
			groupScopes.filter((x) => PERSON_ONLY.test(x)).join(' ')
		);
		check(
			"a person's client metadata has no createGroup permission (making a group is held back in this build)",
			personScopes.length > 1 && !personScopes.some((x) => /createGroup/.test(x)),
			personScopes.filter((x) => /createGroup/.test(x)).join(' ')
		);
		const HELD_BACK_SCOPES =
			/org\.atgrp\.members|listJoinRequests|denyJoinRequest|org\.atgrp\.about|org\.atgrp\.config|org\.atgrp\.meta[^ ]*manage=|authManage/;
		if (!has('members-only-events')) {
			check(
				`${UNIT}: the group client's metadata asks exactly this unit's scopes: the meta read, the declaration and event repo writes, image upload (no members or calendar space)`,
				groupMeta.status === 200 && sameSet(groupScopes, LINK_UNIT_GROUP_SCOPES),
				groupScopes.join(' ')
			);
		} else {
			const heldBack = groupScopes.filter(
				(x) => x !== SPACE_INDEX_SCOPE && HELD_BACK_SCOPES.test(x)
			);
			check(
				"the group client's metadata asks no membership, join-request or settings permission (held back in this build); of the members space, only the read of the group's space index",
				heldBack.length === 0 && groupScopes.includes(SPACE_INDEX_SCOPE),
				heldBack.join(' ') || groupScopes.join(' ')
			);
			check(
				"the group client's calendar scopes name no space key",
				groupScopes.filter((x) => x.startsWith('space:community.lexicon.calendar.collection'))
					.length === 2 &&
					!groupScopes.some(
						(x) => x.startsWith('space:community.lexicon.calendar.collection') && /skey=/.test(x)
					),
				groupScopes.filter((x) => x.includes('calendar.collection')).join(' ')
			);
		}
		if (!has('members-only-events')) {
			// What a person's sign-in may ask for is what their client metadata declares.
			const fromGroups = has('join') ? JOIN_UNIT_PERSON_SCOPES : [];
			if (GROUPS_OFF) {
				const off = await fetch(`${GROUPS_OFF}/oauth-client-metadata.json`);
				const offScopes = String((await off.json().catch(() => ({}))).scope ?? '').split(' ');
				const added = personScopes.filter((x) => !offScopes.includes(x));
				const dropped = offScopes.filter((x) => !personScopes.includes(x));
				note(`with groups on, a person's client metadata adds: ${added.join(' ') || 'nothing'}`);
				check(
					has('join')
						? `${UNIT}: a person's client metadata with groups on is the one with groups off (${GROUPS_OFF}) plus only the join permissions`
						: `${UNIT}: a person's client metadata with groups on equals the one with groups off (${GROUPS_OFF}): their sign-in gains no permission from groups`,
					off.status === 200 &&
						offScopes.length > 1 &&
						dropped.length === 0 &&
						sameSet(added, fromGroups),
					`added: ${added.join(' ')}; dropped: ${dropped.join(' ')}`
				);
			}
			const atgrp = personScopes.filter((x) => /org\.atgrp/.test(x));
			check(
				has('join')
					? `${UNIT}: of org.atgrp, a person's client metadata holds only the join permissions`
					: `${UNIT}: a person's client metadata holds no org.atgrp entry`,
				sameSet(atgrp, fromGroups),
				atgrp.join(' ') || 'none'
			);
		}
		S.flagsGroup = g;
	},
	{ needs: ['people-sign-in'] }
);

step(
	'flags',
	'admin-approval-page-asks-nothing-held-back',
	async (t) => {
		const { alice } = S.pages;
		const g = S.flagsGroup;
		let detail = null;
		let crashed = false;
		let asked = '';
		let members = null;
		await startLink(alice, g.handle);
		await through(alice, ALICE, (u) => u.origin === ATMO, {
			onApprove: async (page) => {
				t.shot = page;
				detail = (
					(await page
						.locator('main form')
						.first()
						.textContent()
						.catch(() => '')) ?? ''
				).replace(/\s+/g, ' ');
				crashed = (await page.getByText(/something went wrong/i).count()) > 0;
				members = await membersSpaceAccess(page);
				asked = (
					(await page
						.locator('pre.scopes')
						.first()
						.textContent()
						.catch(() => '')) ?? ''
				).trim();
				await page.screenshot({ path: shotPath('admin-approval-page') }).catch(() => {});
			}
		});
		await settle(alice);
		t.shot = alice;
		note(`the approval page listed: ${(detail ?? '').slice(0, 900)}`);
		if (!has('members-only-events'))
			check(
				`${UNIT}: the group host's approval page, for alice (an admin) linking atmo, lists only this unit's permissions: the meta read, the declaration and event repo writes and image upload; no members or calendar space, no join-request or settings permission, nothing withheld`,
				detail !== null &&
					onlyTheLinkUnitScopes(asked, members, detail.split(/It would not get/i)[1] ?? '') &&
					!/org\.atgrp\.members|calendar\.collection/.test(detail) &&
					!/join request|listJoinRequests|denyJoinRequest|org\.atgrp\.about|org\.atgrp\.config|settings/i.test(
						detail
					),
				`${asked} / ${JSON.stringify(members)} / ${(detail ?? 'no approval page').slice(0, 400)}`
			);
		else
			check(
				"the group host's approval page, for alice (an admin) linking atmo, lists no membership, join-request or settings permission: of the members space, only the read of the group's space index",
				detail !== null &&
					onlyTheSpaceIndexRead(asked, members) &&
					!/join request|listJoinRequests|denyJoinRequest|org\.atgrp\.about|org\.atgrp\.config|settings/i.test(
						detail
					),
				`${asked} / ${JSON.stringify(members)} / ${(detail ?? 'no approval page').slice(0, 400)}`
			);
		check(
			'...and does not show "Something went wrong"',
			detail !== null && !crashed && !/something went wrong/i.test(detail)
		);
		check(
			'she is back on the group page, linked',
			new URL(alice.url()).pathname === `/groups/${g.did}`,
			alice.url()
		);
	},
	{ needs: ['index-endpoints-answer'] }
);

step('flags', 'off-state', async () => {}, {
	todo: 'the groups-off state needs atmo started without GROUP_HOST_URL, which this run does not restart; check it with a second dev server on another port'
});

// ---------- the parts this build holds back (lib/groups/build.ts): their steps, skipped ----------
// Making a group from the app and its settings page (create), and the members page (roster, but
// for the step that checks its address answers as an unknown one).
for (const name of [
	'allow-making-groups',
	'make-a-public-listed-group',
	'unlisted-group-has-no-declaration',
	'members-only-group-is-not-found-signed-out',
	'same-address-again-is-taken',
	'double-submit-offers-finish-setting-up',
	'unfinished-group-can-be-finished',
	'settings-change-and-records',
	'settings-members-only-and-back'
])
	stepNamed(name).todo = HELD_BACK;
for (const s of defined)
	if (s.section === 'roster' && s.name !== 'members-address-answers-as-unknown') s.todo = HELD_BACK;

// ---------- a build of one stacked part (WALK_UNIT): the later parts' steps, skipped ----------
for (const s of defined) {
	if (s.todo) continue;
	if (
		(s.section === 'join' && !has('join')) ||
		(s.section === 'members-only' && !has('members-only-events'))
	)
		s.todo = NOT_IN_UNIT;
}

/** What of the later parts a page shows: join controls, "Your groups", members-only events. */
async function laterParts(page) {
	const count = (l) => l.count().catch(() => 0);
	return {
		join: await count(
			page.getByRole('button', { name: /^(join|ask to join|allow joining groups)$/i })
		),
		yourGroups: await count(page.getByRole('heading', { name: /your groups/i })),
		membersOnly:
			(await count(moSection(page))) +
			(await count(page.getByRole('button', { name: /members-only events/i }))) +
			(await count(page.getByTestId('members-only-setup'))) +
			(await count(page.getByTestId('members-only-event'))) +
			(await count(page.getByRole('radio', { name: /^members only/i }))) +
			(/members-only/i.test(await body(page).catch(() => '')) ? 1 : 0)
	};
}
if (!has('members-only-events'))
	step(
		'link',
		'nothing-of-later-units',
		async (t) => {
			const { alice, bob, anon } = S.pages;
			const g = await indexedGroup(`nl${RUN}`, `Nether ledge ${RUN}`);
			await reindex(g);
			const seen = [];
			for (const [who, page, where] of [
				['alice, who linked it', alice, groupUrl(g)],
				['alice, its event editor', alice, `${groupUrl(g)}/events/new`],
				['alice, /groups', alice, `${ATMO}/groups`],
				['bob, signed in with no role', bob, groupUrl(g)],
				['bob, /groups', bob, `${ATMO}/groups`],
				['a signed-out visitor', anon, groupUrl(g)]
			]) {
				const res = await page.goto(where, { waitUntil: 'networkidle' });
				seen.push({ who, status: res?.status(), ...(await laterParts(page)) });
			}
			t.shot = alice;
			await alice.goto(groupUrl(g), { waitUntil: 'networkidle' });
			note(`seen: ${JSON.stringify(seen)}`);
			check(
				'each page answered 200, and alice may post an event as the group',
				seen.every((s) => s.status === 200) &&
					(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1,
				JSON.stringify(seen.map((s) => [s.who, s.status]))
			);
			if (!has('join')) {
				check(
					`${UNIT}: no Join, Ask to join or "Allow joining groups" control on the group's page or on /groups, for alice, bob or a visitor`,
					seen.every((s) => s.join === 0),
					JSON.stringify(seen.filter((s) => s.join).map((s) => s.who))
				);
				check(
					`${UNIT}: no "Your groups" section on /groups`,
					seen.every((s) => s.yourGroups === 0),
					JSON.stringify(seen.filter((s) => s.yourGroups).map((s) => s.who))
				);
			} else {
				check(
					`${UNIT}: bob, with no role, is offered to join (Ask to join, or "Allow joining groups" first)`,
					seen.find((s) => s.who === 'bob, signed in with no role').join > 0
				);
			}
			check(
				`${UNIT}: nothing of members-only events: no members-only section, no turn-on control, no "Members only" choice in the event editor, no members-only text`,
				seen.every((s) => s.membersOnly === 0),
				JSON.stringify(seen.filter((s) => s.membersOnly).map((s) => s.who))
			);
		},
		{ needs: ['people-sign-in'] }
	);

// ---------- not yet done by script ----------
step('private', 'todo-lowered-role-gives-visitor-page', async () => {}, {
	todo: 'the visitor page without "Link again" (a role lowered, not removed) needs a role whose read of the meta space the host refuses; by default members read it, so lowering to member leaves the link working. Needs a policy that withholds the meta read, which the host does not allow for members'
});
// =====================================================================================
// the end
// =====================================================================================
const LOG_START = atmoLogSize();
step('wrap', 'groups-page-needs-no-missing-tables', async () => {
	if (!ATMO_LOG) {
		note('no WALK_ATMO_LOG, so the log is not read');
		check('the dev server log was named', false, 'set WALK_ATMO_LOG');
		return;
	}
	const log = atmoLogSince(LOG_START);
	const lines = log.split('\n').filter((l) => /no such table: records_/i.test(l));
	check(
		'atmo\'s log from this run has no "no such table: records_*" (the groups list, before any declaration was indexed, was read on a fresh database at the start of the dev server)',
		lines.length === 0,
		lines.slice(0, 2).join(' | ').slice(0, 300)
	);
});

step('wrap', 'console-approval-page-works', async () => {
	check(
		"the host console's approval page survives its own script when atmo asks to link as an admin (no page broke in this run)",
		S.consoleCrashes === 0,
		`${S.consoleCrashes} console page errors or "Something went wrong" pages`
	);
});

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
		// A skipped step runs nothing, so what it needs is not run for it.
		if (s.todo) return;
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

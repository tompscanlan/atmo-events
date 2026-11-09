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

// ---------- the walk ----------
async function editorPublish(page, name) {
	const field = page.locator('main [contenteditable=true]').first();
	await field.waitFor({ timeout: 30_000 });
	await field.click();
	await page.keyboard.type(name);
	await page.getByRole('button', { name: /^start date/i }).click();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: /^publish/i }).click();
}

const status = async (page, url) => (await page.goto(url, { waitUntil: 'networkidle' }))?.status();

try {
	// Before anything is written, so the index's place in Jetstream comes before this walk's records.
	await runCron();
	const session = await makeGroup(ALICE);
	const did = session.did;
	const handle = await handleOf(did);
	const groupUrl = `${ATMO}/groups/${did}`;
	check(
		'alice makes a group at the host, with an app of her own',
		did.startsWith('did:') && handle === `${LABEL}.${new URL(HOST).hostname}`,
		`${did} ${handle}`
	);
	log(`note: the group is ${did}`);
	await putMeta(session, did, 'group.opensocial.profile', { displayName: NAME });

	const alice = await signIn(ALICE);
	const bob = await signIn(BOB);
	const anon = await pageFor('anon');
	check(
		'alice and bob sign in through their own PDS',
		(await alice.getByRole('button', { name: /^log in$/i }).count()) === 0 &&
			(await bob.getByRole('button', { name: /^log in$/i }).count()) === 0
	);

	await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	check(
		'signed in, /groups offers to link a group; signed out it does not',
		(await alice.locator('#group-link').count()) === 1 &&
			(await anon.locator('#group-link').count()) === 0
	);

	const before = [await status(alice, groupUrl), await status(anon, groupUrl)];
	check(
		'not linked and not listed, its page is a 404, signed in or out',
		before.every((s) => s === 404),
		before.join(' ')
	);

	await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	await alice.fill('#group-link', handle);
	await alice.getByRole('button', { name: /^link$/i }).click();
	await alice.waitForURL((u) => u.origin !== new URL(ATMO).origin, { timeout: 30_000 });
	await through(alice, ALICE, (u) => u.origin === new URL(ATMO).origin);
	await settle(alice);
	const landed = new URL(alice.url());
	check(
		'alice links it by its handle and lands on its page, hers to run',
		landed.pathname === `/groups/${did}` &&
			landed.searchParams.get('link') === 'linked' &&
			(await alice.getByRole('link', { name: /^post an event$/i }).count()) === 1 &&
			(await alice.getByRole('heading', { name: NAME }).count()) === 1,
		alice.url()
	);

	const groupRes = await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	const listRes = await alice.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	// Private at the host, it has no cached profile, so the list names it by its handle.
	const first = alice.locator('main ul li').first();
	const firstText = (await first.innerText()).replace(/\s+/g, ' ');
	check(
		'/groups puts it first for alice, marked Linked',
		(await first.locator(`a[href$="/groups/${did}"]`).count()) === 1 &&
			firstText.includes('Linked') &&
			firstText.includes(handle) &&
			!firstText.includes(NAME),
		firstText
	);
	check(
		'the group page and /groups are never stored',
		groupRes?.headers()['cache-control'] === 'no-store' &&
			listRes?.headers()['cache-control'] === 'no-store',
		`${groupRes?.headers()['cache-control']} ${listRes?.headers()['cache-control']}`
	);
	await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	check('signed out, /groups does not show it', !(await main(anon)).includes(NAME));
	const madeUp = [
		await status(anon, `${ATMO}/groups?link=toString`),
		await status(alice, `${groupUrl}?link=constructor`)
	];
	check(
		'a made-up ?link= is a page, not a 500',
		madeUp.every((s) => s === 200),
		madeUp.join(' ')
	);

	await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'private at the host, it offers no listing',
		(await alice.getByRole('button', { name: /^add to the groups list$/i }).count()) === 0 &&
			(await main(alice)).includes('Private')
	);
	await putMeta(session, did, 'group.opensocial.access', { public: true });
	await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'made public at the host, it offers to add it to the groups list',
		(await alice.getByRole('button', { name: /^add to the groups list$/i }).count()) === 1
	);

	await alice.goto(`${groupUrl}/events/new`, { waitUntil: 'networkidle' });
	await editorPublish(alice, EVENT);
	await alice.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 45_000 });
	await settle(alice);
	const rkey = new URL(alice.url()).pathname.split('/').pop();
	const posted = await until(
		() => repoRecords(did, EVENTS),
		(rs) => rs.some((r) => r.rkey === rkey && r.value?.name === EVENT)
	);
	check(
		"alice posts an event as the group, and it lands in the group's repo",
		new URL(alice.url()).pathname === `/p/${did}/e/${rkey}` && posted.ok,
		alice.url()
	);
	await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'the group page lists it, with an Edit link for alice',
		(await main(alice)).includes(EVENT) &&
			(await alice.locator(`a[href$="/groups/${did}/events/${rkey}/edit"]`).count()) === 1
	);

	await alice.goto(`${groupUrl}/events/${rkey}/edit`, { waitUntil: 'networkidle' });
	const field = alice.locator('main [contenteditable=true]').first();
	await field.waitFor({ timeout: 30_000 });
	await field.click();
	await alice.keyboard.press('End');
	await alice.keyboard.type(' at eight');
	await alice.getByRole('button', { name: /^save changes$/i }).click();
	await alice.waitForURL((u) => !u.pathname.endsWith('/edit'), { timeout: 45_000 });
	const edited = await until(
		() => repoRecords(did, EVENTS),
		(rs) => rs.some((r) => r.rkey === rkey && r.value?.name === RENAMED)
	);
	check(
		"alice edits it, and the group's repo holds the new name",
		edited.ok,
		JSON.stringify(edited.last?.map((r) => r.value?.name))
	);

	await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	await alice.getByRole('button', { name: /^add to the groups list$/i }).click();
	const listed = await until(
		() => repoRecords(did, DECLARATION),
		(rs) => rs.some((r) => r.rkey === 'self')
	);
	await alice.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'alice adds it to the groups list: its declaration is in its repo',
		listed.ok &&
			(await alice.getByRole('button', { name: /^remove from the groups list$/i }).count()) === 1
	);
	const anonGroup = await status(anon, groupUrl);
	const anonSees = (await main(anon)).includes(RENAMED);
	await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	check(
		'signed out, /groups shows it, and its page shows the event',
		anonGroup === 200 && anonSees && (await main(anon)).includes(NAME),
		`page ${anonGroup}, event shown ${anonSees}`
	);

	// bob holds no role in the group. The host turns him away on its own page.
	await bob.goto(groupUrl, { waitUntil: 'networkidle' });
	const offered = await bob.getByRole('button', { name: /^link this group$/i }).count();
	let refusedAt = null;
	bob.on('response', (r) => {
		if (r.request().isNavigationRequest() && new URL(r.url()).origin === HOST && r.status() === 403)
			refusedAt = r.status();
	});
	await bob.getByRole('button', { name: /^link this group$/i }).click();
	await bob.waitForURL((u) => u.origin !== new URL(ATMO).origin, { timeout: 30_000 });
	await through(bob, BOB, (u) => u.origin === new URL(ATMO).origin || refusedAt !== null).catch(
		(e) => log(`  bob: ${e.message}`)
	);
	check(
		'bob, with no role, is offered the link and turned away by the host',
		offered === 1 && refusedAt === 403,
		`offered ${offered}, host ${refusedAt}`
	);
	await bob.goto(groupUrl, { waitUntil: 'networkidle' });
	const bobPost = await status(bob, `${groupUrl}/events/new`);
	const bobEdit = await status(bob, `${groupUrl}/events/${rkey}/edit`);
	await bob.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'no link is kept for bob: no controls, and the editor is a 404',
		(await bob.getByRole('link', { name: /^post an event$/i }).count()) === 0 &&
			(await bob.getByRole('button', { name: /^unlink$/i }).count()) === 0 &&
			bobPost === 404 &&
			bobEdit === 404,
		`new ${bobPost}, edit ${bobEdit}`
	);

	const fresh = await signIn(ALICE);
	await fresh.goto(groupUrl, { waitUntil: 'networkidle' });
	check(
		'in a fresh browser, the link follows alice',
		(await fresh.getByRole('link', { name: /^post an event$/i }).count()) === 1
	);

	await fresh.getByRole('button', { name: /^remove from the groups list$/i }).click();
	const unlisted = await until(
		() => repoRecords(did, DECLARATION),
		(rs) => rs.length === 0
	);
	const anonAfter = await status(anon, groupUrl);
	await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	check(
		'alice removes it from the list: the declaration goes, and signed out it is gone',
		unlisted.ok && anonAfter === 404 && !(await main(anon)).includes(NAME),
		`page ${anonAfter}`
	);

	await fresh.goto(`${groupUrl}/events/${rkey}/edit`, { waitUntil: 'networkidle' });
	await fresh.getByRole('button', { name: /^delete event$/i }).click();
	await fresh.getByRole('button', { name: /^delete$/i }).click();
	await fresh.waitForURL((u) => u.pathname === `/groups/${did}`, { timeout: 45_000 });
	const deleted = await until(
		() => repoRecords(did, EVENTS),
		(rs) => !rs.some((r) => r.rkey === rkey)
	);
	check("alice deletes the event: it leaves the group's repo", deleted.ok);

	await fresh.goto(groupUrl, { waitUntil: 'networkidle' });
	await fresh.getByRole('button', { name: /^unlink$/i }).click();
	await fresh.waitForURL((u) => u.pathname === '/groups', { timeout: 30_000 });
	await settle(fresh);
	const listAfter = await main(fresh);
	const pageAfter = await status(fresh, groupUrl);
	check(
		'alice unlinks it: off her list, and unlisted, its page is a 404 for her',
		!listAfter.includes(NAME) && pageAfter === 404,
		`page ${pageAfter}`
	);

	// A second group lists itself through an app of its own, and nobody opens it as the group in
	// atmo, so atmo holds no cached profile for it. The list must name it by the handle the index
	// holds, not by its DID. The index learns of it from Jetstream alone: nothing tells atmo.
	const other = await makeGroup(ALICE, `${LABEL}b`, DECLARING);
	const otherHandle = await handleOf(other.did);
	await putMeta(other, other.did, 'group.opensocial.access', { public: true });
	await asGroup(other, 'com.atproto.repo.putRecord', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			repo: other.did,
			collection: DECLARATION,
			rkey: 'self',
			record: { $type: DECLARATION, meta: `at://${other.did}/space/${META}/self` }
		})
	});
	const entry = await until(
		async () => {
			await runCron();
			await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
			const item = anon
				.locator('main ul li')
				.filter({ has: anon.locator(`a[href$="/groups/${other.did}"]`) });
			return (await item.count()) ? (await item.first().innerText()).replace(/\s+/g, ' ') : null;
		},
		(text) => text !== null,
		20
	);
	check(
		'a group listed by another app, never opened as the group: signed out, /groups names it by its handle, not its DID',
		entry.ok &&
			otherHandle !== null &&
			entry.last.includes(otherHandle) &&
			!entry.last.includes(other.did),
		`${other.did} ${otherHandle}: ${entry.last ?? 'not listed'}`
	);
} catch (e) {
	check('the walk finished', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
	await browser.close();
}
check('no page errors in any browser', pageErrors === 0, String(pageErrors));
log(`SUMMARY: ${passed} passed, ${failed} failed`);
log(failed === 0 ? 'EVERY CHECK PASSED' : 'SOME CHECKS FAILED');
process.exit(failed === 0 ? 0 : 1);

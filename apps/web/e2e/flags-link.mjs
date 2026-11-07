// One flag state of one built Worker, for link-a-group on #105. MODE=prepare (all on): alice makes a
// group at the host with an app of her own, links it, makes it public, lists it and posts an event as
// it, and her browser is saved. Harness only, not for any PR. MODE=probe: what each route answers, what sign-in declares, what alice
// and a visitor see. Reports; never decides a difference is fine. Run through `snowglobe run --app e2e`.
// Never reads or captures the host's recovery key page.
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const { OAuthClient, MemoryStore } = await import('@atcute/oauth-node-client');
const ir = await import('@atcute/identity-resolver');

const need = (n) => {
	const v = process.env[n]?.trim();
	if (!v) throw new Error(`${n} not set`);
	return v;
};
const ATMO = need('E2E_ATMO');
const HOST = need('E2E_GROUP_HOST');
const PLC = need('E2E_PLC_URL');
const ALICE = { name: 'alice', handle: need('E2E_OWNER_HANDLE'), password: need('E2E_OWNER_PASSWORD') };
const OUT = need('WALK_OUT');
const STATE_FILE = need('STATE_FILE');
const MODE = need('MODE');
const STATE = process.env.STATE ?? 'prepare';
fs.mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(a.join(' ').split(ALICE.password).join('<masked>'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();

async function through(page, who, done, { label } = {}) {
	for (let i = 0; i < 200; i++) {
		const u = new URL(page.url());
		if (done(u)) return;
		if (u.origin === HOST && (await page.locator('#recovery').count().catch(() => 0))) {
			await page.click('#continue');
			await page.locator('#recovery').waitFor({ state: 'detached', timeout: 45_000 });
			continue;
		}
		if (u.origin === HOST && (await page.locator('#consent').isVisible().catch(() => false))) {
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
			if ((await user.count()) && (await user.isEditable()) && !(await user.inputValue())) await user.fill(who.handle);
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
	throw new Error(`stuck at ${page.url().split('?')[0]}`);
}

async function prepare() {
	const RUN = Date.now().toString(36);
	const LABEL = `fl${RUN}`;
	const NAME = `Flag club ${RUN}`;
	const META = 'group.opensocial.meta';
	const REDIRECT = 'http://127.0.0.1:39422/cb';
	const SCOPES = ['atproto', `space:${META}?authority=self&action=read`, 'include:group.opensocial.configure', 'include:group.opensocial.manageSpaces'].join(' ');
	const app = new OAuthClient({
		metadata: { redirect_uris: [REDIRECT], scope: SCOPES },
		actorResolver: new ir.LocalActorResolver({
			handleResolver: new ir.WellKnownHandleResolver(),
			didDocumentResolver: new ir.CompositeDidDocumentResolver({ methods: { plc: new ir.PlcDidDocumentResolver({ apiUrl: PLC }), web: new ir.WebDidDocumentResolver() } })
		}),
		stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) }
	});
	const { url } = await app.authorize({ target: { type: 'pds', serviceUrl: HOST }, scope: SCOPES, prompt: 'create' });
	let cb = null;
	const server = http.createServer((rq, rs) => { cb = new URL(rq.url, REDIRECT); rs.end('ok'); });
	await new Promise((r) => server.listen(39422, '127.0.0.1', r));
	const maker = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	await maker.goto(url.toString(), { waitUntil: 'load', timeout: 60_000 });
	await through(maker, ALICE, () => cb !== null, { label: LABEL });
	await new Promise((r) => server.close(r));
	const { session } = await app.callback(cb.searchParams);
	const did = session.did;
	const put = async (collection, change) => {
		const space = `at://${did}/space/${META}/self`;
		const q = new URLSearchParams({ space, repo: did, collection, rkey: 'self' });
		const now = await (await session.handle(`/xrpc/com.atproto.space.getRecord?${q}`, { method: 'GET' })).json().catch(() => ({}));
		const res = await session.handle('/xrpc/com.atproto.space.putRecord', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ space, repo: did, collection, rkey: 'self', record: { ...(now.value ?? {}), ...change, $type: collection } })
		});
		if (!res.ok) throw new Error(`putRecord ${collection} ${res.status}`);
	};
	await put('group.opensocial.profile', { displayName: NAME });
	await put('group.opensocial.access', { public: true });

	const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
	const a = await ctx.newPage();
	await a.goto(ATMO, { waitUntil: 'networkidle', timeout: 60_000 });
	await a.getByRole('button', { name: /^log in$/i }).first().click();
	await a.locator('input[name=handle]').last().fill(ALICE.handle);
	await a.getByRole('button', { name: /^log in/i }).last().click();
	await a.getByRole('button', { name: /^continue to log in/i }).click({ timeout: 15_000 });
	await a.waitForURL((u) => u.origin !== new URL(ATMO).origin, { timeout: 30_000 });
	await through(a, ALICE, (u) => u.origin === new URL(ATMO).origin);
	await a.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
	await a.fill('#group-link', `${LABEL}.${new URL(HOST).hostname}`);
	await a.getByRole('button', { name: /^link$/i }).click();
	await a.waitForURL((u) => u.origin !== new URL(ATMO).origin, { timeout: 30_000 });
	await through(a, ALICE, (u) => u.origin === new URL(ATMO).origin);
	await a.waitForLoadState('networkidle');
	await a.getByRole('button', { name: /^add to the groups list$/i }).click();
	await sleep(3000);
	await a.goto(`${ATMO}/groups/${did}/events/new`, { waitUntil: 'networkidle' });
	const field = a.locator('main [contenteditable=true]').first();
	await field.waitFor({ timeout: 30_000 });
	await field.click();
	await a.keyboard.type(`Flag walk ${RUN}`);
	await a.getByRole('button', { name: /^start date/i }).click();
	await a.keyboard.press('ArrowRight');
	await a.keyboard.press('Enter');
	await a.getByRole('button', { name: /^publish/i }).click();
	await a.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 45_000 });
	const rkey = new URL(a.url()).pathname.split('/').pop();
	await ctx.storageState({ path: path.join(OUT, 'alice.json') });
	fs.writeFileSync(STATE_FILE, JSON.stringify({ did, name: NAME, rkey, alice: path.join(OUT, 'alice.json') }));
	log(`prepared: group ${did}, event ${rkey}`);
}

async function probe() {
	const saved = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
	const out = { state: STATE, routes: {}, scopes: null, alice: {}, sameAsUnknown: {} };
	log(`===== ${STATE}`);
	const anon = async (method, target, opts = {}) => {
		const r = await fetch(`${ATMO}${target}`, { method, redirect: 'manual', ...opts }).catch((e) => ({ status: `failed ${e.message}`, headers: new Headers() }));
		const loc = r.headers.get('location');
		return `${r.status}${loc ? ` -> ${loc.replace(ATMO, '').split('?')[0]}` : ''}`;
	};
	const form = { 'content-type': 'application/x-www-form-urlencoded', origin: ATMO };
	const g = saved.did;
	for (const [label, method, target, opts] of [
		['/', 'GET', '/'],
		['/events', 'GET', '/events'],
		['/create', 'GET', '/create'],
		['/private', 'GET', '/private'],
		['/groups', 'GET', '/groups'],
		['/groups?server=bad', 'GET', '/groups?server=x'],
		['a group page, signed out', 'GET', `/groups/${g}`],
		['a made-up group, signed out', 'GET', '/groups/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'],
		['its new-event page, signed out', 'GET', `/groups/${g}/events/new`],
		['its event edit, signed out', 'GET', `/groups/${g}/events/${saved.rkey}/edit`],
		['the event, signed out', 'GET', `/p/${g}/e/${saved.rkey}`],
		['group client metadata', 'GET', '/oauth/group/client-metadata.json'],
		['group callback', 'GET', '/oauth/group/callback'],
		['POST group link', 'POST', '/oauth/group/link', { headers: form, body: 'group=x.example.com' }],
		['listDeclared', 'GET', '/xrpc/rsvp.atmo.declaration.listDeclared?limit=5'],
		['declaration getRecord', 'GET', `/xrpc/rsvp.atmo.declaration.getRecord?uri=at://${g}/group.opensocial.declaration/self`],
		['declaration listRecords', 'GET', '/xrpc/rsvp.atmo.declaration.listRecords?limit=5'],
		['an unknown method', 'GET', '/xrpc/rsvp.atmo.no.suchMethod'],
		['client metadata', 'GET', '/oauth-client-metadata.json']
	]) {
		out.routes[label] = await anon(method, target, opts);
		log(`  ${label.padEnd(34)} ${out.routes[label]}`);
	}
	const list = await (await fetch(`${ATMO}/xrpc/rsvp.atmo.declaration.listDeclared?limit=5`)).text();
	const unknown = await (await fetch(`${ATMO}/xrpc/rsvp.atmo.no.suchMethod`)).text();
	out.listDeclaredIsUnknown = list === unknown;
	out.listDeclaredHasGroup = list.includes(g);
	log(`  listDeclared answers as an unknown method: ${out.listDeclaredIsUnknown}; names the group: ${out.listDeclaredHasGroup}`);
	const meta = await (await fetch(`${ATMO}/oauth-client-metadata.json`)).json().catch(() => ({}));
	out.scopes = (meta.scope ?? '').split(' ').filter(Boolean);
	log(`  scopes declared ${out.scopes.length}: ${out.scopes.map((s) => s.split('?')[0]).join(' ')}`);

	const visitor = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	let errors = 0;
	visitor.on('pageerror', () => errors++);
	const mainOf = async (p, u) => {
		const res = await p.goto(`${ATMO}${u}`, { waitUntil: 'networkidle' });
		return { status: res?.status(), text: (await p.locator('main').innerText().catch(() => '')).replace(/\s+/g, ' ').trim() };
	};
	const never = await mainOf(visitor, '/this/address/was/never/here');
	for (const [label, u] of [['/groups', '/groups'], ['a group page', `/groups/${g}`], ['a made-up group', '/groups/did:plc:aaaaaaaaaaaaaaaaaaaaaaaa']]) {
		const seen = await mainOf(visitor, u);
		out.sameAsUnknown[label] = seen.status === 404 ? seen.text === never.text : `status ${seen.status}`;
		log(`  signed out, ${label}: ${seen.status}${seen.status === 404 ? `, same page as an unknown address: ${seen.text === never.text}` : ''}${seen.status === 404 && seen.text !== never.text ? ` (${seen.text.slice(0, 80)})` : ''}`);
	}

	const ctx = await browser.newContext({ ignoreHTTPSErrors: true, storageState: saved.alice });
	const a = await ctx.newPage();
	a.on('pageerror', () => errors++);
	await a.goto(ATMO, { waitUntil: 'networkidle' });
	// The nav's links, outside the page's own content.
	const navLink = (href) => a.locator(`a[href="${href}"]:not(main a)`).count();
	out.alice.signedIn = (await a.getByRole('button', { name: /^log in$/i }).count()) === 0;
	out.alice.navGroups = (await navLink('/groups')) > 0;
	out.alice.navPrivate = (await navLink('/private')) > 0;
	const gp = await a.goto(`${ATMO}/groups/${g}`, { waitUntil: 'networkidle' });
	out.alice.groupPage = gp?.status();
	out.alice.manage = await a.getByRole('link', { name: /^post an event$/i }).count();
	const np = await a.goto(`${ATMO}/groups/${g}/events/new`, { waitUntil: 'networkidle' });
	out.alice.newEvent = np?.status();
	const cr = await a.goto(`${ATMO}/create`, { waitUntil: 'networkidle' });
	out.alice.createInvitedOnly = (await a.locator('main').innerText().catch(() => '')).includes('Invited');
	log(`  alice: signed in ${out.alice.signedIn}, nav Groups ${out.alice.navGroups}, nav Private events ${out.alice.navPrivate}, group page ${out.alice.groupPage} with controls ${out.alice.manage}, new event ${out.alice.newEvent}, /create ${cr?.status()} offers invited ${out.alice.createInvitedOnly}`);
	out.pageErrors = errors;
	log(`  page errors ${errors}`);
	fs.writeFileSync(path.join(OUT, `${STATE}.json`), JSON.stringify(out, null, 1));
}

try {
	if (MODE === 'prepare') await prepare();
	else await probe();
} catch (e) {
	log(`FAILED: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
	process.exitCode = 1;
} finally {
	await browser.close();
}

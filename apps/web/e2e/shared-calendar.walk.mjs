// A shared calendar through atmo's real pages, with real OAuth at real spaces PDSes: one list of people
// and several private events. Then a single private event whose host names its guests, which makes
// them a shared calendar where they are. One browser context per person. After each step the state is read from
// the PDSes with password sessions, not trusted from the page. Prints statuses, never a password.
// It can run on a network an earlier walk used: every name is new each run.
//
//   SG_FILE=snowglobe.private-events.yml pnpm exec snowglobe run --app walk -- pnpm --filter web exec node e2e/shared-calendar.walk.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ATMO = process.env.WALK_ATMO ?? 'http://127.0.0.1:5454';
const OUT = process.env.WALK_OUT ?? '/tmp/shared-calendar-walk';
fs.mkdirSync(OUT, { recursive: true });
const need = (n) => {
	const v = process.env[n]?.trim();
	if (!v) throw new Error(`${n} not set`);
	return v;
};
const person = (who, pds) => ({
	who,
	handle: need(`${who.toUpperCase()}_HANDLE`),
	password: need(`${who.toUpperCase()}_PASSWORD`),
	pds: need(`${pds}_URL`)
});
const P = {
	alice: person('alice', 'ALPHA'),
	bob: person('bob', 'ALPHA'),
	mallory: person('mallory', 'ALPHA'),
	dana: person('dana', 'BETA')
};
const TYPE = 'rsvp.atmo.dev.space';
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';
const CALENDAR = 'rsvp.atmo.dev.calendar';
const MEMBER = 'com.atproto.memberspace.member';

const secrets = Object.entries(process.env)
	.filter(([k]) => /PASSWORD/.test(k))
	.map(([, v]) => v);
const mask = (s) => secrets.reduce((t, x) => (x ? t.split(x).join('<masked>') : t), String(s));
const log = (...a) =>
	console.log(mask(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
const clean = (s, n = 400) => mask(String(s).replace(/\s+/g, ' ').trim()).slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.env.WALK_RESOLVER
	? [`--host-resolver-rules=${process.env.WALK_RESOLVER}`]
	: [];
const browser = await chromium.launch({ args });
let pageErrors = 0;
const shot = (page, name) =>
	page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
const pageFor = async (who) => {
	const ctx = await browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width: 1100, height: 850 }
	});
	const page = await ctx.newPage();
	page.on('pageerror', (e) => {
		pageErrors++;
		log(`  [${who}] browser error: ${clean(e.message, 200)}`);
	});
	return page;
};
// Whole, and it throws rather than giving '', so a check that something is absent can't pass on a page
// that never loaded or on what lies past a cut.
const text = async (page, sel = 'body') =>
	clean(await page.locator(sel).first().innerText({ timeout: 15000 }), Infinity);

async function throughPds(page, who) {
	for (let i = 0; i < 160; i++) {
		const u = new URL(page.url());
		// Only the PDS's own buttons are clicked here. A fast server lands back on atmo within the
		// first polls, and atmo's own "Allow atmo to ..." would skip the step that tests it.
		if (u.origin === ATMO) {
			if (i > 2) {
				await page.waitForLoadState('load').catch(() => {});
				return;
			}
			await sleep(400);
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
		// Never atmo's own button: isVisible waits out a navigation, so `u` above can be stale here.
		const btn = page.getByRole('button', { name: /^(accept|authorize|allow(?! atmo))/i }).first();
		if (await btn.isVisible().catch(() => false)) {
			await btn.click({ timeout: 10000 });
			await sleep(800);
			continue;
		}
		await sleep(400);
	}
	throw new Error(
		`stuck at the PDS for ${who.who}: ${page.url().split('?')[0]} ${await text(page).catch(() => '')}`
	);
}
async function signInForm(page, who) {
	await page.locator('input[name=handle]').last().waitFor({ timeout: 30000 });
	await page.locator('input[name=handle]').last().fill(who.handle);
	await page
		.getByRole('button', { name: /^log in/i })
		.last()
		.click();
	await page.getByRole('button', { name: /^continue to log in/i }).click({ timeout: 15000 });
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30000 });
	await throughPds(page, who);
	log(`  [${who.who}] signed in, back at ${new URL(page.url()).pathname}`);
}
async function signIn(page, who) {
	await page.goto(ATMO, { waitUntil: 'networkidle', timeout: 60000 });
	await page
		.getByRole('button', { name: /^log in$/i })
		.first()
		.click();
	await signInForm(page, who);
}
async function allow(page, name, who, within = page) {
	await within.getByRole('button', { name }).click({ timeout: 30000 });
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30000 });
	await throughPds(page, who);
	await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}
/** A fresh sign-in holds no private event grant, but a run on a network another walk used may skip
 *  the PDS's own screen. Either way the person ends up allowed. */
async function allowIfAsked(page, name, who) {
	const notice = page.locator('[data-testid=grant-notice]');
	if (!(await notice.isVisible().catch(() => false))) return false;
	await allow(page, name, who, notice);
	return true;
}

async function checker(who) {
	const res = await fetch(`${who.pds}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: who.handle, password: who.password })
	});
	if (!res.ok) throw new Error(`createSession ${who.who}: ${res.status}`);
	const { accessJwt, did } = await res.json();
	const call = async (nsid, params) => {
		const u = new URL(`/xrpc/${nsid}`, who.pds);
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
		const r = await fetch(u, { headers: { authorization: `Bearer ${accessJwt}` } });
		return { status: r.status, data: await r.json().catch(() => null) };
	};
	const post = async (nsid, body) => {
		const r = await fetch(`${who.pds}/xrpc/${nsid}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
			body: JSON.stringify(body)
		});
		return { status: r.status, data: await r.json().catch(() => null) };
	};
	const write = async (collection, record) => {
		const r = await post('com.atproto.repo.createRecord', {
			repo: did,
			collection,
			record: { $type: collection, ...record }
		});
		if (r.status !== 200) throw new Error(`createRecord ${who.who}: ${r.status}`);
		return r.data;
	};
	return { ...who, did, call, post, write };
}
const C = {};
for (const [k, v] of Object.entries(P)) C[k] = await checker(v);
const JETSTREAM = need('JETSTREAM_URL');
const CRON_SECRET = need('CRON_SECRET');
const runCron = async () => {
	const r = await fetch(`${ATMO}/api/cron`, {
		method: 'POST',
		// As the built Worker's own scheduled() sends it: SvelteKit 3 refuses a POST with no content type.
		headers: { 'X-Cron-Secret': CRON_SECRET, 'content-type': 'application/json' }
	});
	if (!r.ok) throw new Error(`atmo's cron: ${r.status}`);
};
await runCron();

let failures = 0;
const check = (label, ok, detail = '') => {
	log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
	if (!ok) failures++;
};
const pages = {};
const step = async (title, fn) => {
	log(`===== ${title}`);
	const t0 = Date.now();
	try {
		const v = await fn();
		log(`  (${Date.now() - t0} ms)`);
		return v;
	} catch (e) {
		log(`  STEP FAILED: ${clean(e.message, 700)}`);
		for (const [k, p] of Object.entries(pages)) await shot(p, `fail-${k}`);
		await browser.close();
		process.exit(1);
	}
};

// Its own names each run: accounts outlive a run, and so can an earlier run's calendar.
const RUN = Date.now().toString(36);
const NAME = `Supper club ${RUN}`;
const RENAMED = `${NAME} on Fridays`;
const EVENT_1 = `Soup night ${RUN}`;
const EVENT_2 = `Pie night ${RUN}`;
const CRAFTED = `Crafted by someone on it ${RUN}`;
const PUBLIC_NAME = `Public control ${RUN}`;
const SINGLE_NAME = `Book club ${RUN}`;
const NAMED_AT_ONCE = `Board games ${RUN}`;
const EVENT_3 = `Book night ${RUN}`;
const EVENT_4 = `Second book night ${RUN}`;
const EVENT_5 = `Game night ${RUN}`;
const CALENDAR_NOT_AVAILABLE = "This calendar isn't available";
const EVENT_NOT_AVAILABLE = "This event isn't available";

let KEY, SPACE, CAL_PATH, RKEY_1, RKEY_2, EVENT_1_PATH, EVENT_2_PATH;
// The single event whose guests become a calendar: its key is its space's.
let RKEY_3, SPACE_3, EVENT_3_PATH, RKEY_4, EVENT_4_PATH, RKEY_5, SPACE_5;
let REMOTE = null;

const peopleOnIt = async () => {
	const r = await C.alice.call('com.atproto.memberspace.listMembers', { space: SPACE });
	if (r.status !== 200) throw new Error(`listMembers: ${r.status}`);
	return r.data.members.map((m) => m.did);
};
/** What a repo holds of one collection in the calendar's space, or another. */
const inSpace = async (name, collection, space = SPACE) => {
	const c = C[name];
	const r = await c.call('com.atproto.space.listRecords', {
		space,
		repo: c.did,
		collection
	});
	if (r.status !== 200) throw new Error(`listRecords ${name}: ${r.status} ${r.data?.error}`);
	return r.data.records;
};
/** Whether someone's private events beta is on, as their own repo holds it. */
const betaOn = async (name) => {
	const c = C[name];
	const r = await c.call('com.atproto.repo.getRecord', {
		repo: c.did,
		collection: 'rsvp.atmo.actor.privateEventsBeta',
		rkey: 'self'
	});
	return r.status === 200 && r.data?.value?.privateEvents === true;
};
/** The people alice's server shows everyone on the calendar, as records in her repo there. */
const publishedOnIt = async () => (await inSpace('alice', MEMBER)).map((r) => r.rkey);
const ownRsvp = async (name, rkey, space = SPACE) => {
	const c = C[name];
	const r = await c.call('com.atproto.space.getRecord', {
		space,
		repo: c.did,
		collection: RSVP,
		rkey
	});
	if (r.status === 200) return r.data.value;
	if (r.data?.error === 'RecordNotFound') return null;
	throw new Error(`getRecord ${name}: ${r.status} ${r.data?.error}`);
};
const publicCount = async (name, collection) => {
	const c = C[name];
	const r = await fetch(
		`${c.pds}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: c.did, collection })}`
	);
	if (!r.ok) throw new Error(`listRecords ${name}: ${r.status}`);
	return (await r.json()).records.length;
};
// Under vite dev a click before hydration does nothing, so wait for the network to settle.
const settle = (page) => page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
const open = async (page, target) => {
	const res = await page.goto(`${ATMO}${target}`, { waitUntil: 'load', timeout: 60000 });
	await settle(page);
	return res?.status();
};
// What someone kept out receives, with the keys that differ removed. The pages say these match byte
// for byte, so that a person can't tell a calendar or event that exists from one that doesn't.
const received = async (page, target, keys) => {
	const res = await page.goto(`${ATMO}${target}`, { waitUntil: 'load', timeout: 60000 });
	const withoutKeys = (s) => keys.reduce((t, k) => t.split(k).join('<key>'), s);
	// Every header but the clock, so that any header telling the two apart shows here.
	const headers = Object.entries(res.headers())
		.filter(([name]) => name !== 'date')
		.sort(([a], [b]) => a.localeCompare(b));
	return {
		status: res.status(),
		headers: withoutKeys(JSON.stringify(headers)),
		body: withoutKeys(await res.text())
	};
};
const firstDifference = (a, b) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return `at ${i} of ${a.length}/${b.length}: ${clean(a.slice(i, i + 90))} | ${clean(b.slice(i, i + 90))}`;
};
const MADE_UP_KEY = '3kyyyyyyyyyyy';
const MADE_UP_RKEY = '3kzzzzzzzzzzz';
/** The real address and a made-up one answer the same, but for the keys in them. */
const sameAsMadeUp = async (page, label, real, madeUp, keys, needles) => {
	const a = await received(page, real, keys);
	const b = await received(page, madeUp, keys);
	check(
		`${label}: 404 at the real address and a made-up one`,
		a.status === 404 && b.status === 404,
		`${a.status} ${b.status}`
	);
	check(
		`${label}: the same headers`,
		a.headers === b.headers,
		a.headers === b.headers ? '' : firstDifference(a.headers, b.headers)
	);
	check(
		`${label}: the same bytes`,
		a.body === b.body,
		a.body === b.body ? '' : firstDifference(a.body, b.body)
	);
	const leaked = needles.filter((n) => a.body.includes(n));
	check(`${label}: nothing of it in the response`, leaked.length === 0, leaked.join(', '));
};
const keptOutOfAll = async (page, who, needles) => {
	await sameAsMadeUp(
		page,
		`${who}, the calendar`,
		CAL_PATH,
		CAL_PATH.replace(KEY, MADE_UP_KEY),
		[KEY, MADE_UP_KEY],
		needles
	);
	for (const [n, target, rkey] of [
		[1, EVENT_1_PATH, RKEY_1],
		[2, EVENT_2_PATH, RKEY_2]
	]) {
		await sameAsMadeUp(
			page,
			`${who}, event ${n}`,
			target,
			target.replace(rkey, MADE_UP_RKEY),
			[rkey, MADE_UP_RKEY],
			needles
		);
	}
};
const personRow = (page, name) => page.locator(`[data-person="${C[name].did}"]`);
const addPerson = async (page, who) => {
	await page.locator('input[name=person-handle]').fill(who);
	await page.waitForTimeout(150);
	await page.locator('[data-testid=calendar-people] form button[type=submit]').click();
};
const peopleAlert = (page) => text(page, '[data-testid=calendar-people] [role=alert]');
/** Fills in the editor the way a person does, then publishes, and returns the event's address. */
const publishEvent = async (page, name, lands = new RegExp(`/calendar/${KEY}/[^/]+$`)) => {
	await page.locator('main [contenteditable=true]').first().waitFor({ timeout: 30000 });
	await page.locator('main [contenteditable=true]').first().click();
	await page.keyboard.type(name);
	await page.getByRole('button', { name: /^start date/i }).click();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: /^publish/i }).click();
	await page.waitForURL((u) => lands.test(u.pathname), { timeout: 45000 });
	await settle(page);
	await page.getByRole('heading', { name }).first().waitFor({ timeout: 20000 });
	const at = new URL(page.url()).pathname;
	return { path: at, rkey: at.split('/').at(-1) };
};
const privateNote = (page) => text(page, '[data-testid=private-note]');
const SAYS_PRIVATE_EVENT = (name = NAME) =>
	new RegExp(`Private event\\. Only the people on ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
const guestRow = (page, name) => page.locator(`[data-guest="${C[name].did}"]`);
const policyOf = async (space) =>
	(await C.alice.call('com.atproto.space.getSpace', { space })).data?.policy ?? null;

await step('1. alice signs in and turns on the private events beta', async () => {
	const p = (pages.alice = await pageFor('alice'));
	await signIn(p, P.alice);
	await open(p, '/settings');
	const section = p.locator('[data-testid=private-events-beta]');
	await section.waitFor({ timeout: 20000 });
	const authorize = section.getByRole('button', { name: /authorize now/i });
	if (await authorize.isVisible().catch(() => false)) {
		await allow(p, /authorize now/i, P.alice, section);
		await settle(p);
	}
	const box = section.getByRole('checkbox', { name: /try private events/i });
	await box.waitFor({ timeout: 20000 });
	if (!(await box.isChecked())) {
		await box.click();
		await section.getByRole('button', { name: /^save$/i }).click();
		await section.getByText('Saved.').waitFor({ timeout: 20000 });
	}
	const saved = await C.alice.call('com.atproto.repo.getRecord', {
		repo: C.alice.did,
		collection: 'rsvp.atmo.actor.privateEventsBeta',
		rkey: 'self'
	});
	check(
		'the beta is on, in her own repo',
		saved.status === 200 && saved.data?.value?.privateEvents === true,
		JSON.stringify(saved.data?.value ?? saved.status)
	);
});

await step('2. alice allows shared calendars on /private and makes one', async () => {
	const p = pages.alice;
	await open(p, '/private');
	const section = p.locator('[data-testid=shared-calendars]');
	await section.waitFor({ timeout: 20000 });
	await shot(p, '01-private-before');
	const asked = section.locator('[data-testid=grant-notice]');
	check('she is asked first, in her own words', await asked.isVisible().catch(() => false));
	await allow(p, /allow atmo to make shared calendars/i, P.alice, section);
	await settle(p);
	check('comes back to /private', new URL(p.url()).pathname === '/private', p.url());
	const form = p.locator('[data-testid=new-calendar]');
	await form.waitFor({ timeout: 20000 });
	check(
		'it says what a shared calendar is for, where she makes one',
		/^For a few people you invite to your own events\. Only you add events or people\./.test(
			await text(p, '[data-testid=new-calendar-what]')
		)
	);
	await shot(p, '01b-new-calendar');
	await form.locator('input[name=calendar-name]').fill(NAME);
	await p.waitForTimeout(150);
	await form.getByRole('button', { name: /new shared calendar/i }).click();
	await p.waitForURL((u) => /\/calendar\/[^/]+$/.test(u.pathname), { timeout: 30000 });
	await settle(p);
	CAL_PATH = new URL(p.url()).pathname;
	KEY = CAL_PATH.split('/').at(-1);
	SPACE = `at://${C.alice.did}/space/${TYPE}/${KEY}`;
	await p.getByRole('heading', { name: NAME }).waitFor({ timeout: 20000 });
	await shot(p, '02-calendar-owner');
	check(
		'the page says only the people on it can see its events',
		/Private\. Only the people on this calendar can see its events\./.test(
			await text(p, '[data-testid=calendar-private-note]')
		)
	);
	const policy = await C.alice.call('com.atproto.space.getSpace', { space: SPACE });
	check(
		'a private space on her PDS',
		policy.status === 200 && policy.data?.policy?.$type === 'com.atproto.memberspace.policy',
		JSON.stringify(policy.data?.policy ?? policy.status)
	);
	check('no one else can read it', policy.data?.policy?.publicRead !== true);
	const named = await inSpace('alice', CALENDAR);
	check(
		'its name is one record in her repo in the space',
		named.length === 1 && named[0].rkey === 'self' && named[0].value?.name === NAME,
		JSON.stringify(named.map((r) => [r.rkey, r.value?.name]))
	);
	check('nothing of it in her public repo', (await publicCount('alice', CALENDAR)) === 0);
	check(
		'no one else on it yet',
		(await peopleOnIt()).every((did) => did === C.alice.did)
	);
});

await step('3. alice adds bob and dana by handle', async () => {
	const p = pages.alice;
	await addPerson(p, P.bob.handle);
	await personRow(p, 'bob').waitFor({ timeout: 20000 });
	await addPerson(p, P.dana.handle);
	await personRow(p, 'dana').waitFor({ timeout: 20000 });
	await addPerson(p, 'nobody-here.example.com');
	await p.locator('[data-testid=calendar-people] [role=alert]').waitFor({ timeout: 20000 });
	check('an unknown handle is refused in words', /wasn|weren/.test(await peopleAlert(p)));
	await addPerson(p, P.alice.handle);
	await sleep(1500);
	check('she cannot add herself', /your calendar/i.test(await peopleAlert(p)));
	const m = await peopleOnIt();
	check(
		'her PDS has bob and dana on it, and no one else',
		m.includes(C.bob.did) &&
			m.includes(C.dana.did) &&
			m.every((did) => [C.alice.did, C.bob.did, C.dana.did].includes(did)),
		`${m.length}`
	);
	const published = await publishedOnIt();
	check(
		'her server shows bob and dana in the calendar, for everyone on it',
		published.includes(C.bob.did) && published.includes(C.dana.did),
		`${published.length}`
	);
	await shot(p, '03-people');
});

await step('4. alice puts event 1 on it from the calendar’s page', async () => {
	const p = pages.alice;
	await p.getByRole('link', { name: /new event on this calendar/i }).click({ timeout: 20000 });
	await p.waitForURL((u) => u.pathname === '/create', { timeout: 30000 });
	await settle(p);
	const choice = p.getByRole('radio', { name: /only the people on one of your shared calendars/i });
	await choice.waitFor({ timeout: 20000 });
	check('the shared calendar choice is picked', await choice.isChecked());
	check(
		'with this calendar in the picker',
		(await p.locator('select[name=calendar]').inputValue()) === KEY
	);
	await shot(p, '04-create-on-calendar');
	({ path: EVENT_1_PATH, rkey: RKEY_1 } = await publishEvent(p, EVENT_1));
	await shot(p, '05-event-1-owner');
	check('it lands on the event on the calendar', EVENT_1_PATH === `${CAL_PATH}/${RKEY_1}`);
	check(
		'the page says only the people on the calendar can see it',
		SAYS_PRIVATE_EVENT().test(await privateNote(p)),
		await privateNote(p)
	);
	const events = await inSpace('alice', EVENT);
	check(
		'the event is in her repo in the calendar’s space',
		events.some((r) => r.rkey === RKEY_1 && r.value?.name === EVENT_1)
	);
	const own = await C.alice.call('com.atproto.space.getSpace', {
		space: `at://${C.alice.did}/space/${TYPE}/${RKEY_1}`
	});
	check('it has no space of its own', own.status !== 200, `${own.status}`);
	check('0 events in her public repo', (await publicCount('alice', EVENT)) === 0);
	check(
		'her panel lists the calendar’s people',
		(await p.locator(`[data-testid=calendar-guests] [data-guest="${C.bob.did}"]`).count()) === 1
	);
	check(
		'and changes no one there',
		(await p.locator('[data-testid=calendar-guests] input').count()) === 0
	);
});

await step('5. bob opens the calendar’s link, signs in, allows it, and sees event 1', async () => {
	const p = (pages.bob = await pageFor('bob'));
	p.on('request', (r) => {
		const found = /\/_app\/remote\/([^/]+)\/rsvpToPrivateEvent/.exec(r.url());
		if (found) REMOTE = found[1];
	});
	await open(p, CAL_PATH);
	check('signed out, he is asked to sign in', /sign in to see whether/i.test(await text(p)));
	check('signed out, the name is nowhere', !(await text(p)).includes(NAME));
	await p.getByRole('button', { name: /^sign in$/i }).click({ timeout: 30000 });
	await signInForm(p, P.bob);
	await settle(p);
	check('back on the calendar', new URL(p.url()).pathname === CAL_PATH, new URL(p.url()).pathname);
	await allowIfAsked(p, /allow atmo to open/i, P.bob);
	await p.getByRole('heading', { name: NAME }).waitFor({ timeout: 30000 });
	await shot(p, '06-calendar-person-on-it');
	check('he sees event 1 on it', (await text(p, 'main')).includes(EVENT_1));
	check(
		'he is told only the people on it can see its events',
		/Private\. Only the people on this calendar can see its events\./.test(
			await text(p, '[data-testid=calendar-private-note]')
		)
	);
	const shown = await text(p, '[data-testid=calendar-people-shown]');
	check(
		'he sees who is on it: himself and dana',
		shown.includes(P.bob.handle) && shown.includes(P.dana.handle),
		shown.slice(0, 200)
	);
	check(
		'nothing on the list for him to change',
		(await p.locator('[data-testid=calendar-people]').count()) === 0 &&
			(await p.getByRole('button', { name: /remove/i }).count()) === 0
	);
	await p.locator(`a[href$="/${RKEY_1}"]`).first().click();
	await p.waitForURL((u) => u.pathname === EVENT_1_PATH, { timeout: 30000 });
	await settle(p);
	await p.getByRole('heading', { name: EVENT_1 }).first().waitFor({ timeout: 20000 });
	check('the event says who can see it', SAYS_PRIVATE_EVENT().test(await privateNote(p)));
	const guests = await text(p, '[data-testid=calendar-guests]');
	check(
		'the event shows him who is on the calendar',
		guests.includes(P.dana.handle),
		guests.slice(0, 200)
	);
	check('with nothing telling him to change it', !/to add or remove people/i.test(guests));
	check('no edit for him', (await p.getByRole('link', { name: /edit/i }).count()) === 0);
});

await step('6. bob says going, in his own repo in the calendar’s space', async () => {
	const p = pages.bob;
	await p
		.getByRole('button', { name: /^going$/i })
		.first()
		.click({ timeout: 20000 });
	let answer = null;
	for (let i = 0; i < 40 && !answer; i++) {
		answer = await ownRsvp('bob', RKEY_1);
		if (!answer) await sleep(250);
	}
	check('his answer is there', answer?.status === `${RSVP}#going`, JSON.stringify(answer));
	check(
		'it names event 1 on the calendar',
		answer?.subject?.uri === `${SPACE}/${C.alice.did}/${EVENT}/${RKEY_1}`,
		answer?.subject?.uri
	);
	check('0 RSVPs in his public repo', (await publicCount('bob', RSVP)) === 0);
	await p.locator('[data-testid=find-again]').waitFor({ timeout: 20000 });
	check(
		'with the beta off, he is offered it, to find this again under Calendars',
		/find this again under Calendars/.test(await text(p, '[data-testid=find-again]'))
	);
	check(
		'and is no longer asked to answer',
		!/Answer to let the host know/.test(await privateNote(p))
	);
	check(
		'his own row in the list says going at once',
		/\bGoing\b/.test(await text(p, `[data-testid=calendar-guests] [data-guest="${C.bob.did}"]`))
	);
	await shot(p, '07-bob-going');
	const a = pages.alice;
	await open(a, EVENT_1_PATH);
	check(
		'alice sees he is going',
		/\bGoing\b/.test(await text(a, `[data-testid=calendar-guests] [data-guest="${C.bob.did}"]`))
	);
});

await step('7. dana on another PDS opens the link and answers interested', async () => {
	const p = (pages.dana = await pageFor('dana'));
	await signIn(p, P.dana);
	await open(p, CAL_PATH);
	await allowIfAsked(p, /allow atmo to open/i, P.dana);
	await p.getByRole('heading', { name: NAME }).waitFor({ timeout: 30000 });
	await open(p, EVENT_1_PATH);
	await p
		.getByRole('button', { name: /^interested$/i })
		.first()
		.click({ timeout: 20000 });
	let answer = null;
	for (let i = 0; i < 40 && !answer; i++) {
		answer = await ownRsvp('dana', RKEY_1);
		if (!answer) await sleep(250);
	}
	check('her answer is in her own repo', answer?.status === `${RSVP}#interested`);

	// She takes the offer. Saving the beta needs one more permission, granted at her PDS, and the
	// click finishes on the way back.
	const offer = p.locator('[data-testid=find-again]');
	await offer.getByRole('button', { name: /turn on private events/i }).click({ timeout: 20000 });
	await p.waitForURL((u) => u.origin !== ATMO, { timeout: 15000 }).catch(() => {});
	if (new URL(p.url()).origin !== ATMO) await throughPds(p, P.dana);
	await p
		.locator('[data-testid=find-again]', { hasText: 'Private events are on' })
		.waitFor({ timeout: 30000 });
	check('the beta is on in her own repo', await betaOn('dana'));
	check(
		'the tab is there for her now',
		(await p.locator('nav[aria-label="Event navigation"] a[href="/private"]').count()) > 0
	);
	await open(p, '/');
	await p.locator('[data-testid=your-private-event]').first().waitFor({ timeout: 20000 });
	check('and her home page lists event 1', (await text(p, 'main')).includes(EVENT_1));
	await shot(p, '07b-dana-found-again');
});

await step('8. alice puts event 2 on it', async () => {
	const p = pages.alice;
	await open(p, `/create?audience=calendar&calendar=${KEY}`);
	({ path: EVENT_2_PATH, rkey: RKEY_2 } = await publishEvent(p, EVENT_2));
	const events = await inSpace('alice', EVENT);
	check(
		'both events in her repo in the space',
		[RKEY_1, RKEY_2].every((k) => events.some((r) => r.rkey === k)),
		`${events.length}`
	);
});

await step(
	'9. bob’s Calendars page lists the calendar, whose page has event 2, with no new link',
	async () => {
		const p = pages.bob;
		const status = await open(p, '/private');
		check('/private loaded', status === 200, `${status}`);
		await p.locator('[data-testid=calendar-list]').waitFor({ timeout: 20000 });
		const cals = await text(p, '[data-testid=calendar-list]');
		check('the calendar he is on is listed', cals.includes(NAME), cals.slice(0, 200));
		check('owned by alice', cals.includes(P.alice.handle), cals.slice(0, 200));
		check(
			'nothing for him to make one with, with the beta off',
			(await p.locator('[data-testid=new-calendar]').count()) === 0
		);
		const whole = await text(p, 'main');
		check(
			'its events are on its own page, not here',
			![EVENT_1, EVENT_2].some((n) => whole.includes(n)),
			whole.slice(0, 200)
		);
		await shot(p, '08-bob-private');
		await p.locator(`[data-testid=calendar-list] a[href$="/calendar/${KEY}"]`).first().click();
		await p.waitForURL((u) => u.pathname === CAL_PATH, { timeout: 30000 });
		await settle(p);
		check('the calendar’s page lists event 2', (await text(p, 'main')).includes(EVENT_2));
		await open(p, EVENT_2_PATH);
		await p.getByRole('heading', { name: EVENT_2 }).first().waitFor({ timeout: 20000 });
		check('he opens event 2', (await text(p, 'main')).includes(EVENT_2));

		// Your events on the home page and the tab: his way back, though he never turned the beta on.
		await open(p, '/');
		const hisHome = await text(p, 'main');
		check(
			'his home page lists neither, with the beta off',
			![EVENT_1, EVENT_2].some((n) => hisHome.includes(n))
		);
		check(
			'no tab for him, with the beta off',
			!(await betaOn('bob')) &&
				(await p.locator('nav[aria-label="Event navigation"] a[href="/private"]').count()) === 0
		);
		const a = pages.alice;
		await open(a, '/');
		const hers = a.locator('[data-testid=your-private-event]');
		await hers.first().waitFor({ timeout: 20000 });
		const herHome = await text(a, 'main');
		check(
			'her home page lists event 1 and event 2 among her events',
			herHome.includes(EVENT_1) && herHome.includes(EVENT_2)
		);
		for (const [n, rkey] of [
			[1, RKEY_1],
			[2, RKEY_2]
		]) {
			check(
				`event ${n} there opens on the calendar`,
				(await hers.locator(`a[href$="/calendar/${KEY}/${rkey}"]`).count()) === 1
			);
		}
		check(
			'each marked private to the calendar',
			(herHome.match(new RegExp(SAYS_PRIVATE_EVENT(), 'g')) ?? []).length >= 2,
			herHome.slice(0, 200)
		);
		await shot(a, '08b-alice-home');
	}
);

await step('10. mallory, not on it, gets what a made-up address gets', async () => {
	const p = (pages.mallory = await pageFor('mallory'));
	await signIn(p, P.mallory);
	await open(p, CAL_PATH);
	await allowIfAsked(p, /allow atmo to open/i, P.mallory);
	const status = await open(p, CAL_PATH);
	check('a 404 on the calendar', status === 404, `${status}`);
	check('in its words', (await text(p, 'main')).includes(CALENDAR_NOT_AVAILABLE));
	await shot(p, '09-mallory');
	await keptOutOfAll(p, 'mallory', [NAME, EVENT_1, EVENT_2]);
	await open(p, '/private');
	check('nothing of it on her /private', !(await text(p, 'main')).includes(NAME));
});

await step('11. alice adds mallory, who then sees both events', async () => {
	const a = pages.alice;
	await open(a, CAL_PATH);
	await addPerson(a, P.mallory.handle);
	await personRow(a, 'mallory').waitFor({ timeout: 20000 });
	const p = pages.mallory;
	const status = await open(p, CAL_PATH);
	check('the calendar opens for her now', status === 200, `${status}`);
	const main = await text(p, 'main');
	check('with event 1, made before she was added', main.includes(EVENT_1));
	check('and event 2', main.includes(EVENT_2));
	const one = await open(p, EVENT_1_PATH);
	check('she opens event 1', one === 200 && (await text(p, 'main')).includes(EVENT_1), `${one}`);
});

await step('12. alice removes dana, who loses everything on it at once', async () => {
	const a = pages.alice;
	await open(a, CAL_PATH);
	await personRow(a, 'dana')
		.getByRole('button', { name: /remove/i })
		.click();
	await personRow(a, 'dana').waitFor({ state: 'detached', timeout: 20000 });
	check('off the list on her PDS', !(await peopleOnIt()).includes(C.dana.did));
	const d = pages.dana;
	const cal = await open(d, CAL_PATH);
	const one = await open(d, EVENT_1_PATH);
	const two = await open(d, EVENT_2_PATH);
	check(
		'dana gets a 404 for all three',
		[cal, one, two].every((s) => s === 404),
		`${cal} ${one} ${two}`
	);
	await keptOutOfAll(d, 'dana, removed', [NAME, EVENT_1, EVENT_2]);
	await open(d, '/private');
	const left = await text(d, 'main');
	check('none of it on her /private', ![NAME, EVENT_1, EVENT_2].some((n) => left.includes(n)));
	check(
		'her answer stays in her own repo',
		(await ownRsvp('dana', RKEY_1))?.status?.endsWith('interested')
	);
	const published = await publishedOnIt();
	check(
		'her server no longer shows dana on it, and still shows bob',
		!published.includes(C.dana.did) && published.includes(C.bob.did),
		`${published.length}`
	);
	const b = pages.bob;
	await open(b, CAL_PATH);
	await b.getByRole('heading', { name: NAME }).waitFor({ timeout: 30000 });
	const still = await text(b, '[data-testid=calendar-people-shown]');
	check(
		'bob no longer sees dana on it, by handle or DID',
		!still.includes(P.dana.handle) && !still.includes(C.dana.did) && still.includes(P.bob.handle),
		still.slice(0, 200)
	);
});

await step('13. bob cannot add an event or change who is on it', async () => {
	const p = pages.bob;
	await open(p, CAL_PATH);
	await p.getByRole('heading', { name: NAME }).waitFor({ timeout: 20000 });
	check(
		'no control to add an event',
		(await p.getByRole('link', { name: /new event on this calendar/i }).count()) === 0
	);
	check(
		'no rename or delete',
		(await p.locator('[data-testid=calendar-owner-actions]').count()) === 0
	);
	check('the commands were seen, so the crafted calls go where atmo’s do', REMOTE !== null);

	// atmo's own commands, called as his page would, with what no page of his offers.
	const record = {
		$type: EVENT,
		name: CRAFTED,
		createdAt: new Date().toISOString(),
		startsAt: new Date(Date.now() + 86400000).toISOString()
	};
	const crafted = await p.evaluate(
		async ({ remote, calls }) => {
			// The argument as SvelteKit sends it: devalue's flat form, then URL-safe base64.
			const devalue = (value) => {
				const out = [];
				const flatten = (v) => {
					const i = out.length;
					out.push(null);
					if (Array.isArray(v)) out[i] = v.map(flatten);
					else if (v && typeof v === 'object')
						out[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, flatten(x)]));
					else out[i] = v;
					return i;
				};
				flatten(value);
				return JSON.stringify(out);
			};
			const encode = (s) =>
				btoa(String.fromCharCode(...new TextEncoder().encode(s)))
					.replaceAll('=', '')
					.replaceAll('+', '-')
					.replaceAll('/', '_');
			const results = {};
			for (const [name, arg] of Object.entries(calls)) {
				const res = await fetch(`/_app/remote/${remote}/${name}`, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-sveltekit-pathname': location.pathname,
						'x-sveltekit-search': ''
					},
					body: JSON.stringify({ payload: encode(devalue(arg)), refreshes: [] })
				});
				// A refused command still answers 200, with its error and that error's status inside.
				const body = await res.json().catch(() => null);
				results[name] = `${res.status} ${body?.type} ${body?.error?.status}`;
			}
			return results;
		},
		{
			remote: REMOTE,
			calls: {
				savePrivateEvent: { rkey: '3kcraftedcraft', record, calendar: KEY },
				addPersonToCalendar: { key: KEY, handleOrDid: P.bob.handle },
				removePersonFromCalendar: { key: KEY, did: C.mallory.did },
				deleteCalendar: { key: KEY }
			}
		}
	);
	log(`  crafted calls: ${JSON.stringify(crafted)}`);
	check(
		'atmo refuses each crafted call, as a refusal',
		Object.values(crafted).every((s) => s === '200 error 409'),
		JSON.stringify(crafted)
	);
	check('alice’s calendar still has its 2 events', (await inSpace('alice', EVENT)).length === 2);
	const m = await peopleOnIt();
	check('and the same people', m.includes(C.mallory.did) && m.includes(C.bob.did), `${m.length}`);

	// At the PDS itself, someone on it can write a record of his own in the space. It counts for nothing.
	const own = await C.bob.post('com.atproto.space.putRecord', {
		space: SPACE,
		repo: C.bob.did,
		collection: EVENT,
		rkey: '3kcraftedcraft',
		record
	});
	log(`  bob's own record in the space: ${own.status} ${own.data?.error ?? ''}`);
	await open(p, CAL_PATH);
	check('his record is not on the calendar for him', !(await text(p, 'main')).includes(CRAFTED));
	await open(pages.alice, CAL_PATH);
	check('nor for alice', !(await text(pages.alice, 'main')).includes(CRAFTED));
	const at = await open(p, `${CAL_PATH}/3kcraftedcraft`);
	check('nor at its own address', at === 404, `${at}`);
	// His beta is off, so his Your events lists no private events; alice's lists the calendar's.
	const a = pages.alice;
	await open(a, '/');
	await a.locator('[data-testid=your-private-event]').first().waitFor({ timeout: 20000 });
	check('nor in alice’s Your events', !(await text(a, 'main')).includes(CRAFTED));
});

await step('14. alice renames the calendar, and deletes event 2', async () => {
	const a = pages.alice;
	await open(a, CAL_PATH);
	await a.getByRole('button', { name: /^rename$/i }).click();
	const input = a.locator('form input[name=calendar-name]');
	await input.fill(RENAMED);
	await a.waitForTimeout(150);
	await a.getByRole('button', { name: /^save$/i }).click();
	await a.getByRole('heading', { name: RENAMED }).waitFor({ timeout: 20000 });
	await open(pages.bob, CAL_PATH);
	check('bob sees the new name', (await text(pages.bob, 'main h1')).includes(RENAMED));

	await open(a, `${EVENT_2_PATH}/edit`);
	await a
		.getByRole('button', { name: /^delete/i })
		.first()
		.click({ timeout: 20000 });
	const confirm = a.getByRole('button', { name: /^delete/i }).last();
	await confirm.click({ timeout: 10000 }).catch(() => {});
	await a.waitForURL((u) => u.pathname === CAL_PATH, { timeout: 30000 });
	await settle(a);
	check('alice is back on the calendar', !(await text(a, 'main')).includes(EVENT_2));
	const events = await inSpace('alice', EVENT);
	check(
		'only event 2’s record is gone',
		events.length === 1 && events[0].rkey === RKEY_1,
		JSON.stringify(events.map((r) => r.rkey))
	);
	const b = pages.bob;
	const gone = await open(b, EVENT_2_PATH);
	check('event 2 is a 404 for bob', gone === 404, `${gone}`);
	check('in the same words', (await text(b, 'main')).includes(EVENT_NOT_AVAILABLE));
	const cal = await open(b, CAL_PATH);
	const main = await text(b, 'main');
	check('the calendar stays for him', cal === 200, `${cal}`);
	check('with event 1 and not event 2', main.includes(EVENT_1) && !main.includes(EVENT_2));
	check('his answer to event 1 stands', (await ownRsvp('bob', RKEY_1))?.status === `${RSVP}#going`);
});

await step(
	'15. alice makes a single private event for bob and mallory, and bob answers',
	async () => {
		const a = pages.alice;
		await open(a, '/create');
		await a.getByRole('radio', { name: /invited people only/i }).click();
		const field = a.getByRole('textbox', { name: /name this list to reuse it for later events/i });
		await field.waitFor({ timeout: 20000 });
		check(
			'she is offered a name for its guests, saying what naming it shows',
			/Everyone on it sees its name and who else is on it\./.test(
				await text(a, '[data-testid=naming-tells]')
			)
		);
		await shot(a, '11-create-single');
		({ path: EVENT_3_PATH, rkey: RKEY_3 } = await publishEvent(a, EVENT_3, /\/private\/[^/]+$/));
		SPACE_3 = `at://${C.alice.did}/space/${TYPE}/${RKEY_3}`;
		check('it has a space of its own', (await policyOf(SPACE_3))?.$type !== undefined);
		check(
			'with no name, so its guests are not shown to each other',
			(await inSpace('alice', CALENDAR, SPACE_3)).length === 0 &&
				(await policyOf(SPACE_3))?.publishMembers !== true
		);
		const before = await open(a, `/p/${P.alice.handle}/calendar/${RKEY_3}`);
		check('it has no calendar page yet', before === 404, `${before}`);
		await open(a, EVENT_3_PATH);
		await a.locator('input[name=guest-handle]').fill(P.bob.handle);
		await a.waitForTimeout(150);
		await a.locator('[data-testid=guest-list] form button[type=submit]').click();
		await guestRow(a, 'bob').waitFor({ timeout: 20000 });
		await a.locator('input[name=guest-handle]').fill(P.mallory.handle);
		await a.waitForTimeout(150);
		await a.locator('[data-testid=guest-list] form button[type=submit]').click();
		await guestRow(a, 'mallory').waitFor({ timeout: 20000 });
		check(
			'she is offered to save these people as a shared calendar',
			(await a.getByRole('button', { name: /save these people as a shared calendar/i }).count()) ===
				1
		);
		check(
			'and no event on it before it has a name',
			(await a.getByRole('link', { name: /new event on this calendar/i }).count()) === 0
		);
		check(
			'nothing published for its guests',
			(await inSpace('alice', MEMBER, SPACE_3)).length === 0
		);

		const b = pages.bob;
		await open(b, EVENT_3_PATH);
		await b.getByRole('heading', { name: EVENT_3 }).first().waitFor({ timeout: 20000 });
		check(
			'bob is told only the people the host added can see it',
			/Only people the host added can see it/.test(await privateNote(b))
		);
		check('and is shown no one else on it', !(await text(b, 'main')).includes(P.mallory.handle));
		await b
			.getByRole('button', { name: /^going$/i })
			.first()
			.click({ timeout: 20000 });
		let answer = null;
		for (let i = 0; i < 40 && !answer; i++) {
			answer = await ownRsvp('bob', RKEY_3, SPACE_3);
			if (!answer) await sleep(250);
		}
		check('his answer is in his own repo in its space', answer?.status === `${RSVP}#going`);
	}
);

await step('16. alice saves its guests as a shared calendar, and nothing moves', async () => {
	const a = pages.alice;
	const eventBefore = (await inSpace('alice', EVENT, SPACE_3)).map((r) => [r.rkey, r.cid]);
	const answerBefore = await ownRsvp('bob', RKEY_3, SPACE_3);
	await open(a, EVENT_3_PATH);
	await a.getByRole('button', { name: /save these people as a shared calendar/i }).click();
	const form = a.locator('[data-testid=save-as-calendar]');
	check(
		'she is told what naming it shows',
		/Everyone on it sees its name and who else is on it\./.test(
			await text(a, '[data-testid=save-as-calendar] [data-testid=naming-tells]')
		)
	);
	await form.locator('input[name=calendar-name]').fill(SINGLE_NAME);
	await a.waitForTimeout(150);
	await form.getByRole('button', { name: /^save$/i }).click();
	await a.locator('[data-testid=private-to]').waitFor({ timeout: 20000 });
	await shot(a, '12-single-named-host');
	check('she stays at the event’s own address', new URL(a.url()).pathname === EVENT_3_PATH);
	check(
		'the event now says only the people on the calendar can see it',
		SAYS_PRIVATE_EVENT(SINGLE_NAME).test(await privateNote(a)),
		await privateNote(a)
	);
	check(
		'with a link to the calendar’s page',
		(await a.locator(`[data-testid=private-to] a[href$="/calendar/${RKEY_3}"]`).count()) === 1
	);
	const named = await inSpace('alice', CALENDAR, SPACE_3);
	check(
		'one name record in her repo in the event’s own space',
		named.length === 1 && named[0].rkey === 'self' && named[0].value?.name === SINGLE_NAME,
		JSON.stringify(named.map((r) => [r.rkey, r.value?.name]))
	);
	check(
		'the event record is where it was, unchanged',
		JSON.stringify((await inSpace('alice', EVENT, SPACE_3)).map((r) => [r.rkey, r.cid])) ===
			JSON.stringify(eventBefore)
	);
	check(
		'bob’s answer is where it was',
		JSON.stringify(await ownRsvp('bob', RKEY_3, SPACE_3)) === JSON.stringify(answerBefore)
	);
	check(
		'its people are shown to everyone on it now',
		(await policyOf(SPACE_3))?.publishMembers === true
	);
	const published = (await inSpace('alice', MEMBER, SPACE_3)).map((r) => r.rkey);
	check(
		'her server shows bob and mallory there',
		published.includes(C.bob.did) && published.includes(C.mallory.did),
		`${published.length}`
	);
	check('nothing of it in her public repo', (await publicCount('alice', CALENDAR)) === 0);
});

await step('17. bob sees its name and who else is on it, at the link he had', async () => {
	const b = pages.bob;
	const status = await open(b, EVENT_3_PATH);
	check('the old link still opens', status === 200, `${status}`);
	await b.getByRole('heading', { name: EVENT_3 }).first().waitFor({ timeout: 20000 });
	await shot(b, '13-single-named-bob');
	check('he sees the calendar’s name', SAYS_PRIVATE_EVENT(SINGLE_NAME).test(await privateNote(b)));
	const guests = await text(b, '[data-testid=calendar-guests]');
	check('and mallory on it', guests.includes(P.mallory.handle), guests.slice(0, 200));
	check(
		'his own answer stands',
		/\bGoing\b/.test(await text(b, `[data-testid=calendar-guests] [data-guest="${C.bob.did}"]`))
	);
	const cal = await open(b, `/p/${P.alice.handle}/calendar/${RKEY_3}`);
	check('its calendar page opens for him', cal === 200, `${cal}`);
	check('with the name and the event', (await text(b, 'main')).includes(EVENT_3));
	check(
		'the event there links to the address it always had',
		(await b.locator(`main a[href$="/private/${RKEY_3}"]`).count()) === 1
	);
	await open(b, '/private');
	const cals = await text(b, '[data-testid=calendar-list]');
	check(
		'his Calendars page lists it among calendars',
		cals.includes(SINGLE_NAME),
		cals.slice(0, 200)
	);
	check(
		'and lists no event of its own, only calendars',
		(await b.locator('main a[href*="/private/"]').count()) === 0
	);
});

await step(
	'18. alice adds a second event on it, which bob finds with no new link; cancelling it leaves the calendar',
	async () => {
		const a = pages.alice;
		const calPath = `/p/${P.alice.handle}/calendar/${RKEY_3}`;
		await open(a, calPath);
		await a.getByRole('link', { name: /new event on this calendar/i }).click({ timeout: 20000 });
		await a.waitForURL((u) => u.pathname === '/create', { timeout: 30000 });
		await settle(a);
		check(
			'the calendar is picked',
			(await a.locator('select[name=calendar]').inputValue()) === RKEY_3
		);
		({ path: EVENT_4_PATH, rkey: RKEY_4 } = await publishEvent(
			a,
			EVENT_4,
			new RegExp(`/calendar/${RKEY_3}/[^/]+$`)
		));
		check('it is in the same space', (await inSpace('alice', EVENT, SPACE_3)).length === 2);
		const b = pages.bob;
		await open(b, calPath);
		check('bob finds it on the calendar he has', (await text(b, 'main')).includes(EVENT_4));
		await open(b, EVENT_4_PATH);
		await b.getByRole('heading', { name: EVENT_4 }).first().waitFor({ timeout: 20000 });
		check('and opens it', SAYS_PRIVATE_EVENT(SINGLE_NAME).test(await privateNote(b)));

		await open(a, `${EVENT_4_PATH}/edit`);
		await a
			.getByRole('button', { name: /^delete/i })
			.first()
			.click({ timeout: 20000 });
		await a
			.getByRole('button', { name: /^delete/i })
			.last()
			.click({ timeout: 10000 })
			.catch(() => {});
		await a.waitForURL((u) => u.pathname === calPath, { timeout: 30000 });
		await settle(a);
		const left = (await inSpace('alice', EVENT, SPACE_3)).map((r) => r.rkey);
		check('only the second event is gone', left.length === 1 && left[0] === RKEY_3, left.join(','));
		check('the calendar stays', (await policyOf(SPACE_3)) !== null);
		const still = await open(b, EVENT_3_PATH);
		check('the first event’s link still opens for bob', still === 200, `${still}`);
	}
);

await step(
	'19. a single event named as it is made is a calendar at once; cancelling it leaves the calendar',
	async () => {
		const a = pages.alice;
		await open(a, '/create');
		await a.getByRole('radio', { name: /invited people only/i }).click();
		await a
			.getByRole('textbox', { name: /name this list to reuse it for later events/i })
			.fill(NAMED_AT_ONCE);
		await a.waitForTimeout(150);
		({ rkey: RKEY_5 } = await publishEvent(a, EVENT_5, /\/private\/[^/]+$/));
		SPACE_5 = `at://${C.alice.did}/space/${TYPE}/${RKEY_5}`;
		check(
			'it opens as an event on its calendar',
			SAYS_PRIVATE_EVENT(NAMED_AT_ONCE).test(await privateNote(a)),
			await privateNote(a)
		);
		const named = await inSpace('alice', CALENDAR, SPACE_5);
		check('its space has the name', named.length === 1 && named[0].value?.name === NAMED_AT_ONCE);
		check(
			'and shows its people to everyone on it',
			(await policyOf(SPACE_5))?.publishMembers === true
		);
		await open(a, `/p/${P.alice.handle}/private/${RKEY_5}/edit`);
		await a
			.getByRole('button', { name: /^delete/i })
			.first()
			.click({ timeout: 20000 });
		await a
			.getByRole('button', { name: /^delete/i })
			.last()
			.click({ timeout: 10000 })
			.catch(() => {});
		await a.waitForURL((u) => u.pathname === '/', { timeout: 30000 });
		check('the event is gone', (await inSpace('alice', EVENT, SPACE_5)).length === 0);
		check(
			'the calendar stays, with its name',
			(await inSpace('alice', CALENDAR, SPACE_5)).length === 1
		);
		await open(a, '/private');
		check(
			'and is still on her Calendars page',
			(await text(a, '[data-testid=calendar-list]')).includes(NAMED_AT_ONCE)
		);
	}
);

await step(
	'20. nothing of it reached the public network or atmo, and a public event did',
	async () => {
		const control = await C.mallory.write(EVENT, {
			name: PUBLIC_NAME,
			startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
			createdAt: new Date().toISOString(),
			mode: `${EVENT}#inperson`,
			status: `${EVENT}#scheduled`
		});
		const controlKey = control.uri.split('/').at(-1);
		// Not the space type's name: its lexicon is a public record on purpose.
		const needles = [
			...[NAME, RENAMED, EVENT_1, EVENT_2, CRAFTED, KEY, SPACE, RKEY_1, RKEY_2],
			...[SINGLE_NAME, NAMED_AT_ONCE, EVENT_3, EVENT_4, EVENT_5, SPACE_3, RKEY_3, RKEY_4, RKEY_5]
		];

		const seen = await new Promise((resolve, reject) => {
			const ws = new WebSocket(`${JETSTREAM.replace(/^http/, 'ws')}/subscribe?cursor=0`);
			const found = { messages: 0, control: false, leaks: [], collections: {}, notControls: 0 };
			let quiet;
			const finish = () => {
				ws.close();
				resolve(found);
			};
			const giveUp = setTimeout(finish, 60000);
			ws.onerror = () => {
				clearTimeout(giveUp);
				clearTimeout(quiet);
				reject(new Error('jetstream connection failed'));
			};
			ws.onmessage = async (m) => {
				const raw = typeof m.data === 'string' ? m.data : await m.data.text();
				found.messages++;
				const message = JSON.parse(raw);
				const c = message.commit?.collection;
				if (c) found.collections[c] = (found.collections[c] ?? 0) + 1;
				// From the start of the network, so an earlier walk's controls show too. Those are mallory's.
				if (c === EVENT && message.did !== C.mallory.did) found.notControls++;
				if (raw.includes(PUBLIC_NAME)) found.control = true;
				for (const n of needles) if (raw.includes(n)) found.leaks.push(n);
				clearTimeout(quiet);
				quiet = setTimeout(() => (found.control ? (clearTimeout(giveUp), finish()) : null), 3000);
			};
		});
		log(`  jetstream: ${seen.messages} messages, ${JSON.stringify(seen.collections)}`);
		check('the public event is on the firehose, so the firehose works', seen.control);
		check('nothing of the calendar is on it', seen.leaks.length === 0, seen.leaks.join(', '));
		check('no calendar record on it at all', !seen.collections[CALENDAR]);
		check(
			'the only events on it are public controls',
			seen.notControls === 0,
			`${seen.notControls} of ${seen.collections[EVENT]}`
		);
		check('no RSVP on it at all', !seen.collections[RSVP], `${seen.collections[RSVP] ?? 0}`);

		const exported = async (c) => {
			const r = await fetch(
				`${c.pds}/xrpc/com.atproto.sync.getRepo?${new URLSearchParams({ did: c.did })}`
			);
			if (!r.ok) throw new Error(`getRepo ${c.who}: ${r.status}`);
			return Buffer.from(await r.arrayBuffer());
		};
		check(
			'the public event is in its person’s exported repo',
			(await exported(C.mallory)).includes(PUBLIC_NAME)
		);
		for (const name of ['alice', 'bob', 'dana', 'mallory']) {
			const repo = await exported(C[name]);
			const leaks = needles.filter((needle) => repo.includes(needle));
			check(`nothing of it in ${name}’s exported repo`, leaks.length === 0, leaks.join(', '));
		}

		let indexed = null;
		for (let i = 0; i < 6 && !indexed; i++) {
			await runCron();
			const r = await fetch(`${ATMO}/p/${C.mallory.handle}/e/${controlKey}/data.json`);
			if (r.ok) indexed = await r.json();
			else if (r.status !== 404) throw new Error(`atmo's event data: ${r.status}`);
		}
		check('atmo indexed the public event, so ingest works', indexed?.value?.name === PUBLIC_NAME);
		for (const [n, rkey] of [
			[1, RKEY_1],
			[2, RKEY_2],
			[3, RKEY_3],
			[4, RKEY_4],
			[5, RKEY_5]
		]) {
			const hidden = await fetch(`${ATMO}/p/${C.alice.handle}/e/${rkey}/data.json`);
			check(`atmo has no public copy of event ${n}`, hidden.status === 404, `${hidden.status}`);
		}
		const listing = await pages.mallory.request.get(`${ATMO}/events?filter=all`);
		const html = await listing.text();
		check('/events loaded', listing.status() === 200, `${listing.status()}`);
		check('/events shows the public event', html.includes(PUBLIC_NAME));
		const onEvents = needles.filter((n) => html.includes(n));
		check('/events has nothing of the calendar', onEvents.length === 0, onEvents.join(', '));
		const profile = await pages.mallory.request.get(`${ATMO}/p/${C.alice.handle}`);
		const publicPage = await profile.text();
		check('alice’s public page loaded', profile.status() === 200, `${profile.status()}`);
		const onProfile = needles.filter((n) => publicPage.includes(n));
		check('alice’s public page has nothing of it', onProfile.length === 0, onProfile.join(', '));
	}
);

await step('21. alice deletes the calendar, and bob’s link reads as not available', async () => {
	const a = pages.alice;
	await open(a, CAL_PATH);
	await a.getByRole('button', { name: /^delete calendar$/i }).click({ timeout: 20000 });
	await a.locator('[data-testid=confirm-delete]').waitFor({ timeout: 10000 });
	await a.getByRole('button', { name: /delete it for everyone/i }).click();
	await a.waitForURL((u) => u.pathname === '/private', { timeout: 30000 });
	await settle(a);
	check('off her list', !(await text(a, 'main')).includes(RENAMED));
	const gone = await C.alice.call('com.atproto.space.getSpace', { space: SPACE });
	check('the space is gone from her PDS', gone.status !== 200, `${gone.status}`);
	const b = pages.bob;
	const status = await open(b, CAL_PATH);
	check('bob gets a 404, not a 500', status === 404, `${status}`);
	check('in the same words', (await text(b, 'main')).includes(CALENDAR_NOT_AVAILABLE));
	await shot(b, '10-bob-after-delete');
	await sameAsMadeUp(
		b,
		'bob, after the delete',
		CAL_PATH,
		CAL_PATH.replace(KEY, MADE_UP_KEY),
		[KEY, MADE_UP_KEY],
		[NAME, RENAMED, EVENT_1]
	);
	const one = await open(b, EVENT_1_PATH);
	check('event 1 is a 404 for him too', one === 404, `${one}`);
	await open(b, '/private');
	const list = await text(b, 'main');
	check('none of it on his /private', ![RENAMED, EVENT_1].some((n) => list.includes(n)));
	check(
		'his answer stays in his repo, unreadable to anyone else',
		(await ownRsvp('bob', RKEY_1)) !== null
	);
});

check('no uncaught error in any browser', pageErrors === 0, `${pageErrors}`);
await browser.close();
log(failures ? `\n${failures} CHECK(S) FAILED` : '\nEVERY CHECK PASSED');
process.exit(failures ? 1 : 0);

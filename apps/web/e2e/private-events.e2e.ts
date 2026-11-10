// A person's private event, on the network in snowglobe.private-events.yml (`pnpm test:e2e:private`
// from the repo root): through atmo's real pages, with real OAuth at real spaces PDSes, one browser
// context per person. After each step the state is read from the PDSes with password sessions, not
// trusted from the page.
//
// One test per step, in order, sharing the state below. Checks are soft, so a run reports every
// check that failed. A step that throws stops the walk: each step builds on the ones before, so the
// rest are skipped. Screenshots go to OUT. Nothing printed holds a password.
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { ATMO, required, runCron } from './atmo-server';

const TYPE = 'rsvp.atmo.dev.space';
const EVENT = 'community.lexicon.calendar.event';
const RSVP = 'community.lexicon.calendar.rsvp';
const OUT = join(tmpdir(), 'atmo-private-events-e2e');

type Name = 'alice' | 'bob' | 'mallory' | 'dana' | 'carol';
interface Person {
	who: Name;
	handle: string;
	password: string;
	pds: string;
}
const person = (who: Name, pds: 'ALPHA' | 'BETA' | 'REGULAR'): Person => ({
	who,
	handle: required(`E2E_${who.toUpperCase()}_HANDLE`),
	password: required(`E2E_${who.toUpperCase()}_PASSWORD`),
	pds: required(`E2E_${pds}_PDS`)
});
const P: Record<Name, Person> = {
	alice: person('alice', 'ALPHA'),
	bob: person('bob', 'ALPHA'),
	mallory: person('mallory', 'ALPHA'),
	dana: person('dana', 'BETA'),
	carol: person('carol', 'REGULAR')
};
const JETSTREAM = required('E2E_JETSTREAM');
const cron = () => runCron(inject('cronSecret'));

const secrets = Object.values(P).map((p) => p.password);
const mask = (s: unknown) => secrets.reduce((t, x) => t.split(x).join('<masked>'), String(s));
const log = (...parts: unknown[]) =>
	console.log(mask(parts.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')));
const clean = (s: unknown, n = 400) => mask(String(s).replace(/\s+/g, ' ').trim()).slice(0, n);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A soft check: a failure is reported, and the step carries on. */
const check = (label: string, ok: boolean, detail = '') =>
	expect.soft(ok, clean(detail ? `${label}: ${detail}` : label, 700)).toBe(true);

let browser: Browser;
let pageErrors = 0;
const pages = {} as Record<Name, Page>;
const shot = (page: Page, name: string) =>
	page.screenshot({ path: join(OUT, `${name}.png`), fullPage: true }).catch(() => {});
async function pageFor(who: string) {
	const context = await browser.newContext({
		ignoreHTTPSErrors: true,
		viewport: { width: 1100, height: 850 }
	});
	const page = await context.newPage();
	page.on('pageerror', (error) => {
		pageErrors++;
		log(`  [${who}] browser error: ${clean(error.message, 200)}`);
	});
	return page;
}
// Whole, and it throws rather than giving '', so a check that something is absent can't pass on a page
// that never loaded or on what lies past a cut.
const text = async (page: Page, selector = 'body') =>
	clean(await page.locator(selector).first().innerText({ timeout: 15000 }), Infinity);

async function throughPds(page: Page, who: Person) {
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
		clean(
			`stuck at the PDS for ${who.who}: ${page.url().split('?')[0]} ${await text(page).catch(() => '')}`
		)
	);
}
async function signInForm(page: Page, who: Person) {
	await page.locator('input[name=handle]').last().waitFor({ timeout: 30000 });
	await page.locator('input[name=handle]').last().fill(who.handle);
	await page
		.getByRole('button', { name: /^log in/i })
		.last()
		.click();
	await page.getByRole('button', { name: /^continue to log in/i }).click({ timeout: 15000 });
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30000 });
	await throughPds(page, who);
}
async function signIn(page: Page, who: Person) {
	await page.goto(ATMO, { waitUntil: 'networkidle', timeout: 60000 });
	await page
		.getByRole('button', { name: /^log in$/i })
		.first()
		.click();
	await signInForm(page, who);
}
async function allow(page: Page, name: RegExp, who: Person) {
	await page.getByRole('button', { name }).click({ timeout: 30000 });
	await page.waitForURL((u) => u.origin !== ATMO, { timeout: 30000 });
	await throughPds(page, who);
	await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}
/** Clicks an answer, then waits for it on the PDS, and says what the page says if it never lands. */
async function answer(page: Page, name: RegExp, who: Name, want: string) {
	await page.getByRole('button', { name }).first().click({ timeout: 20000 });
	for (let i = 0; i < 40; i++) {
		if ((await ownRsvp(who)) === want) return true;
		await sleep(250);
	}
	log(`  [${who}] the page says: ${await text(page, 'main')}`);
	return false;
}

interface Read<T> {
	status: number;
	data: (T & { error?: string }) | null;
}
interface Checker extends Person {
	did: string;
	call<T>(nsid: string, params: Record<string, string>): Promise<Read<T>>;
	write(collection: string, record: object): Promise<{ uri: string; cid: string }>;
}
async function checker(who: Person): Promise<Checker> {
	const res = await fetch(`${who.pds}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: who.handle, password: who.password })
	});
	if (!res.ok) throw new Error(`createSession ${who.who}: ${res.status}`);
	const { accessJwt, did } = (await res.json()) as { accessJwt: string; did: string };
	const call = async <T>(nsid: string, params: Record<string, string>): Promise<Read<T>> => {
		const u = new URL(`/xrpc/${nsid}`, who.pds);
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
		const r = await fetch(u, { headers: { authorization: `Bearer ${accessJwt}` } });
		return { status: r.status, data: (await r.json().catch(() => null)) as Read<T>['data'] };
	};
	const write = async (collection: string, record: object) => {
		const r = await fetch(`${who.pds}/xrpc/com.atproto.repo.createRecord`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', authorization: `Bearer ${accessJwt}` },
			body: JSON.stringify({ repo: did, collection, record: { $type: collection, ...record } })
		});
		if (!r.ok) throw new Error(`createRecord ${who.who}: ${r.status}`);
		return (await r.json()) as { uri: string; cid: string };
	};
	return { ...who, did, call, write };
}
const C = {} as Record<Name, Checker>;

// Its own name each run: accounts outlive a run, and so can an earlier run's event.
const run = Date.now().toString(36);
const NAME = `Dinner ${run}`;
const RENAMED = `${NAME} at eight`;
const PUBLIC_NAME = `Public control ${run}`;
const NOT_AVAILABLE = "This event isn't available";
let KEY = '';
let SPACE = '';
let EVENT_PATH = '';

const members = async () => {
	const r = await C.alice.call<{ members: { did: string }[] }>(
		'com.atproto.memberspace.listMembers',
		{ space: SPACE }
	);
	if (r.status !== 200 || !r.data) throw new Error(`listMembers: ${r.status}`);
	return r.data.members.map((m) => m.did);
};
const sameMembers = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();
const ownRsvp = async (name: Name) => {
	const c = C[name];
	const r = await c.call<{ value: { status: string } }>('com.atproto.space.getRecord', {
		space: SPACE,
		repo: c.did,
		collection: RSVP,
		rkey: KEY
	});
	if (r.status === 200 && r.data) return r.data.value.status.split('#')[1];
	if (r.data?.error === 'RecordNotFound') return null;
	throw new Error(`getRecord ${name}: ${r.status} ${r.data?.error}`);
};
const publicCount = async (name: Name, collection: string) => {
	const c = C[name];
	const r = await fetch(
		`${c.pds}/xrpc/com.atproto.repo.listRecords?${new URLSearchParams({ repo: c.did, collection })}`
	);
	if (!r.ok) throw new Error(`listRecords ${name}: ${r.status}`);
	return ((await r.json()) as { records: unknown[] }).records.length;
};
// Under vite dev a click before hydration does nothing, so wait for the network to settle.
const settle = (page: Page) =>
	page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
const open = async (page: Page, target = EVENT_PATH) => {
	const res = await page.goto(`${ATMO}${target}`, { waitUntil: 'load', timeout: 60000 });
	await settle(page);
	return res?.status();
};
// What someone kept out receives, with the address itself removed. `+page.server.ts` says these match
// byte for byte, so that a person can't tell an event that exists from one that doesn't.
const received = async (page: Page, target: string) => {
	const t0 = Date.now();
	const res = await page.goto(`${ATMO}${target}`, { waitUntil: 'load', timeout: 60000 });
	const ms = Date.now() - t0;
	if (!res) throw new Error(`no response at ${target}`);
	const keyOf = target.split('/').at(-1) ?? target;
	const withoutKey = (s: string) => s.split(keyOf).join('<key>');
	// Every header but the clock, so that any header telling the two apart shows here.
	const headers = Object.entries(res.headers())
		.filter(([name]) => name !== 'date')
		.sort(([a], [b]) => a.localeCompare(b));
	return {
		ms,
		status: res.status(),
		headers: withoutKey(JSON.stringify(headers)),
		body: withoutKey(await res.text())
	};
};
const firstDifference = (a: string, b: string) => {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return `at ${i} of ${a.length}/${b.length}: ${clean(a.slice(i, i + 90))} | ${clean(b.slice(i, i + 90))}`;
};
const sameAsMadeUp = async (who: string, page: Page, label: string) => {
	const made = EVENT_PATH.replace(KEY, '3kzzzzzzzzzzz');
	// Opening is asked per address, so go through that at the made-up one, as they did at the real one.
	await open(page, made);
	if (await page.locator('[data-testid=open-first]').count()) await chooseToOpen(page);
	const a = await received(page, EVENT_PATH);
	const b = await received(page, made);
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
	check(`${label}: not the event's name in the response`, !a.body.includes(NAME));
	log(`  [${who}] ms real ${a.ms} made-up ${b.ms}`);
};
const listLoads = async (page: Page, label: string) => {
	const status = await open(page, '/private');
	check(`${label}: /private loaded`, status === 200, `${status}`);
};
// The attendee list, not the host's guest list, which names everyone added. The page shows only
// avatars there, so this opens the list of names.
const inAttendees = async (page: Page, group: string, handle: string) => {
	const opener = page
		.locator('main button', { hasText: new RegExp(`\\d+\\s*${group}`, 'i') })
		.first();
	if ((await opener.count()) === 0) return false;
	await opener.click({ timeout: 10000 });
	const dialog = page.getByRole('dialog');
	await dialog.waitFor({ timeout: 10000 });
	const found = (await dialog.locator(`a[href="/p/${encodeURIComponent(handle)}"]`).count()) > 0;
	await page.keyboard.press('Escape');
	await dialog.waitFor({ state: 'detached', timeout: 10000 });
	return found;
};
const openFirst = (page: Page) =>
	page.locator('[data-testid=open-first]').waitFor({ timeout: 30000 });
// Opening one tells the host's server who is asking, so a guest chooses to, on an ordinary POST.
const chooseToOpen = async (page: Page) => {
	await page.getByRole('button', { name: /^open this event$/i }).click({ timeout: 30000 });
	await page.waitForLoadState('load');
	await settle(page);
};
const guestRow = (page: Page, name: Name) => page.locator(`[data-guest="${C[name].did}"]`);
const addGuest = async (page: Page, who: string) => {
	await page.locator('input[name=guest-handle]').fill(who);
	await page.waitForTimeout(150);
	await page.locator('[data-testid=guest-list] form button[type=submit]').click();
};
const GUEST_ALERT = '[data-testid=guest-list] [role=alert]';
/** Whether an add was refused: the form is free again with the handle still in it (an add that
 *  worked empties it), and an alert says why. The alert's words are the server's, so they aren't
 *  matched; what landed is checked on the PDS. */
const refused = async (page: Page, handle: string) => {
	const form = page.locator('[data-testid=guest-list] form');
	// Add is off while a request runs, and on an empty box.
	const add = form.locator('button[type=submit]');
	for (let i = 0; i < 80 && !(await add.isEnabled()); i++) await sleep(250);
	return (
		(await add.isEnabled()) &&
		(await form.locator('input[name=guest-handle]').inputValue()) === handle &&
		(await page.locator(GUEST_ALERT).isVisible())
	);
};

// The step that threw, after which the rest are skipped.
let broken: string | undefined;
function step(title: string, fn: () => Promise<void>, timeout?: number) {
	it(
		title,
		async ({ skip }) => {
			skip(broken !== undefined, `step "${broken}" failed, and this one needs it`);
			try {
				await fn();
			} catch (error) {
				broken = title;
				for (const [name, page] of Object.entries(pages)) await shot(page, `fail-${name}`);
				log(`  screenshots: ${OUT}`);
				throw error;
			}
		},
		timeout
	);
}

beforeAll(async () => {
	mkdirSync(OUT, { recursive: true });
	browser = await chromium.launch();
	for (const name of Object.keys(P) as Name[]) C[name] = await checker(P[name]);
	// The first run sets where atmo starts reading Jetstream, so what the walk writes comes after.
	await cron();
});
afterAll(async () => {
	await browser?.close();
});

describe('a private event, on servers with spaces and one without', () => {
	step('1. alice signs in with the ordinary login', async () => {
		pages.alice = await pageFor('alice');
		await signIn(pages.alice, P.alice);
	});

	step('2. alice picks invited people only on /create and allows it', async () => {
		const p = pages.alice;
		await open(p, '/create');
		await p.getByText('Who can see this event?').waitFor({ timeout: 30000 });
		check(
			'no editor before a choice',
			!(await p
				.getByRole('button', { name: /^publish/i })
				.isVisible()
				.catch(() => false))
		);
		await p.getByLabel(/invited people only/i).check();
		await p.locator('[data-testid=grant-notice]').waitFor({ timeout: 10000 });
		await shot(p, '01-create-ask');
		await allow(p, /allow atmo to host/i, P.alice);
		await settle(p);
		check(
			'comes back to the choice she made',
			new URL(p.url()).searchParams.get('audience') === 'invited',
			p.url()
		);
	});

	step('3. alice fills in the editor and publishes', async () => {
		const p = pages.alice;
		await p.locator('main [contenteditable=true]').first().waitFor({ timeout: 30000 });
		const body = await text(p, 'main');
		check(
			'no Public / Unlisted switch',
			!/Unlisted/.test(await p.locator('main').innerText()),
			body.slice(0, 80)
		);
		await p.locator('main [contenteditable=true]').first().click();
		await p.keyboard.type(NAME);
		await p.getByRole('button', { name: /^start date/i }).click();
		await p.keyboard.press('ArrowRight');
		await p.keyboard.press('Enter');
		await shot(p, '02-create-editor');
		await p.getByRole('button', { name: /^publish/i }).click();
		await p.waitForURL((u) => /\/private\/[^/]+$/.test(u.pathname), { timeout: 45000 });
		await settle(p);
		EVENT_PATH = new URL(p.url()).pathname;
		KEY = EVENT_PATH.split('/').at(-1) ?? '';
		SPACE = `at://${C.alice.did}/space/${TYPE}/${KEY}`;
		await p.getByRole('heading', { name: NAME }).first().waitFor({ timeout: 20000 });
		await shot(p, '03-event-host');
		check('0 events in her public repo', (await publicCount('alice', EVENT)) === 0);
		const inSpace = await C.alice.call<{
			value?: { name?: string; media?: unknown[]; preferences?: unknown };
		}>('com.atproto.space.getRecord', {
			space: SPACE,
			repo: C.alice.did,
			collection: EVENT,
			rkey: KEY
		});
		check('the event is in the space', inSpace.status === 200, inSpace.data?.value?.name);
		check('it has no image', !inSpace.data?.value?.media?.length);
		check(
			'it has no discovery preference, since nothing lists it',
			inSpace.data?.value?.preferences === undefined,
			JSON.stringify(inSpace.data?.value?.preferences)
		);
		const policy = await C.alice.call<{ policy?: { $type?: string } }>(
			'com.atproto.space.getSpace',
			{ space: SPACE }
		);
		check('memberspace policy', policy.data?.policy?.$type === 'com.atproto.memberspace.policy');
		const blobs = await C.alice.call<{ cids: string[] }>('com.atproto.sync.listBlobs', {
			did: C.alice.did
		});
		check(
			'no blob uploaded',
			blobs.status === 200 && blobs.data?.cids.length === 0,
			`${blobs.status}`
		);
	});

	step('4. someone signed out opens the address', async () => {
		const p = await pageFor('visitor');
		const raw = await p.request.get(`${ATMO}${EVENT_PATH}`);
		const html = await raw.text();
		check('the event name is nowhere in the HTML', !html.includes(NAME), `status ${raw.status()}`);
		await open(p);
		check('asks them to sign in', /sign in to see whether/i.test(await text(p)));
		await p.context().close();
	});

	step('5. alice adds guests by handle', async () => {
		const p = pages.alice;
		await addGuest(p, P.bob.handle);
		await guestRow(p, 'bob').waitFor({ timeout: 20000 });
		check('bob listed, not answered', /hasn't answered/.test(await guestRow(p, 'bob').innerText()));
		check(
			'the host is told the link is the invitation',
			/link is the invitation/i.test(await text(p, '[data-testid=guest-list]'))
		);
		await addGuest(p, P.dana.handle);
		await guestRow(p, 'dana').waitFor({ timeout: 20000 });
		await addGuest(p, P.carol.handle);
		await guestRow(p, 'carol').waitFor({ timeout: 20000 });
		const listed = await members();
		await addGuest(p, 'nobody-here.example.com');
		await p.locator(GUEST_ALERT).waitFor({ timeout: 20000 });
		check(
			'an unknown handle is refused, and stays in the box',
			await refused(p, 'nobody-here.example.com'),
			await text(p, GUEST_ALERT).catch(() => 'no alert')
		);
		await addGuest(p, P.alice.handle);
		await sleep(1500);
		check(
			'she cannot add herself',
			(await refused(p, P.alice.handle)) && (await guestRow(p, 'alice').count()) === 0,
			await text(p, GUEST_ALERT).catch(() => 'no alert')
		);
		const m = await members();
		check(
			'PDS has bob, dana and carol on the list',
			[C.bob.did, C.dana.did, C.carol.did].every((d) => m.includes(d)),
			`${m.length}`
		);
		check(
			'and nothing else from the refused adds',
			sameMembers(m, listed),
			`${listed.length} ${m.length}`
		);
		await shot(p, '04-guests');
	});

	step('6. bob opens the link, signs in, allows it, sees the event', async () => {
		const p = (pages.bob = await pageFor('bob'));
		await open(p);
		await p.getByRole('button', { name: /^sign in$/i }).click({ timeout: 30000 });
		await signInForm(p, P.bob);
		await settle(p);
		check(
			'back on the event address',
			new URL(p.url()).pathname === EVENT_PATH,
			new URL(p.url()).pathname
		);
		await p.locator('[data-testid=grant-notice]').waitFor({ timeout: 30000 });
		await shot(p, '05-guest-ask');
		await allow(p, /allow atmo to open/i, P.bob);
		await openFirst(p);
		await shot(p, '05b-guest-open-first');
		check('asked before anything is read', !(await text(p, 'main')).includes(NAME));
		await chooseToOpen(p);
		await p.getByRole('heading', { name: NAME }).first().waitFor({ timeout: 30000 });
		const again = await open(p);
		check(
			'and not asked again',
			again === 200 && !(await text(p, 'main')).includes('Open this event')
		);
		check(
			'tells him to answer',
			/Answer to let the host know/.test(await text(p, '[data-testid=private-note]'))
		);
		check('no guest list for a guest', (await p.locator('[data-testid=guest-list]').count()) === 0);
		check(
			'no edit button for a guest',
			(await p.getByRole('link', { name: /edit/i }).count()) === 0
		);
		check('nothing in his repo yet', (await ownRsvp('bob')) === null);
		await shot(p, '06-event-guest');
	});

	step('7. bob says going, and the host sees his answer', async () => {
		const p = pages.bob;
		check(
			'his answer is in his own repo in the space',
			await answer(p, /^going$/i, 'bob', 'going')
		);
		// The pop-up would open once the page has its answer back, so wait for the page to say so.
		await p.getByText("You're Going", { exact: true }).first().waitFor({ timeout: 20000 });
		check(
			'no pop-up asks him to share it',
			(await p.getByText("You're going!", { exact: true }).count()) === 0
		);
		check('0 RSVPs in his public repo', (await publicCount('bob', RSVP)) === 0);
		const a = pages.alice;
		await a.reload({ waitUntil: 'load' });
		await settle(a);
		await guestRow(a, 'bob').waitFor({ timeout: 20000 });
		check('alice sees he is going', /\bGoing\b/.test(await guestRow(a, 'bob').innerText()));
		check('alice sees him going, by handle', await inAttendees(a, 'going', P.bob.handle));
		await shot(a, '07-host-after-going');
		await p.reload({ waitUntil: 'load' });
		await settle(p);
		await sleep(500);
		const note = await text(p, '[data-testid=private-note]');
		check(
			'bob still sees his answer after a reload',
			!/Answer to let the host know/.test(note),
			note
		);
	});

	step('8. dana on another PDS answers interested', async () => {
		const p = (pages.dana = await pageFor('dana'));
		await signIn(p, P.dana);
		await open(p);
		await allow(p, /allow atmo to open/i, P.dana);
		await openFirst(p);
		await chooseToOpen(p);
		await p.getByRole('heading', { name: NAME }).first().waitFor({ timeout: 30000 });
		check('her answer is in her own repo', await answer(p, /^interested$/i, 'dana', 'interested'));
		const a = pages.alice;
		await a.reload({ waitUntil: 'load' });
		await settle(a);
		await guestRow(a, 'dana').waitFor({ timeout: 20000 });
		check(
			'alice sees she is interested',
			/\bInterested\b/.test(await guestRow(a, 'dana').innerText())
		);
	});

	step('9. mallory, not invited, gets what a made-up address gets', async () => {
		const p = (pages.mallory = await pageFor('mallory'));
		await signIn(p, P.mallory);
		await open(p);
		await allow(p, /allow atmo to open/i, P.mallory);
		await openFirst(p);
		const madeUp = EVENT_PATH.replace(KEY, '3kzzzzzzzzzzz');
		const askedHere = await text(p, 'main');
		await chooseToOpen(p);
		const realStatus = await open(p);
		const real = await text(p, 'main');
		await open(p, madeUp);
		check('asked the same words at either address', (await text(p, 'main')) === askedHere);
		await chooseToOpen(p);
		const made = await open(p, madeUp);
		const madeText = await text(p, 'main');
		check('both 404', realStatus === 404 && made === 404, `${realStatus} ${made}`);
		check('the same words', real === madeText, real.slice(0, 120));
		check('the name nowhere', !real.includes(NAME));
		await sameAsMadeUp('mallory', p, 'mallory, on the host’s PDS');
		check('not added', !(await members()).includes(C.mallory.did));
	});

	step(
		'10. carol on a stock PDS is told her server cannot, and the rest of atmo works',
		async () => {
			const p = (pages.carol = await pageFor('carol'));
			await signIn(p, P.carol);
			await open(p);
			await allow(p, /allow atmo to open/i, P.carol);
			await sleep(800);
			await p.locator('[data-testid=grant-notice]').waitFor({ timeout: 30000 });
			check(
				'says her server cannot',
				/Your server did not give atmo permission/.test(await text(p, '[data-testid=grant-notice]'))
			);
			check('the name nowhere', !(await text(p, 'main')).includes(NAME));
			await shot(p, '08-stock-pds');
			const events = await p.goto(`${ATMO}/events`, { waitUntil: 'load', timeout: 60000 });
			check('/events still works', events?.status() === 200);
		}
	);

	step('11. /private lists it for host and guest', async () => {
		await open(pages.alice, '/private');
		await pages.alice.locator('[data-testid=private-events]').waitFor({ timeout: 20000 });
		check(
			'alice: hosting',
			/You are hosting/.test(await text(pages.alice, '[data-testid=private-events]'))
		);
		await shot(pages.alice, '09-private-host');
		await open(pages.bob, '/private');
		await pages.bob.locator('[data-testid=private-events]').waitFor({ timeout: 20000 });
		check(
			'bob: hosted by alice',
			(await text(pages.bob, '[data-testid=private-events]')).includes(P.alice.handle)
		);
		check(
			'the card opens the private page',
			(await pages.bob.locator(`[data-testid=private-events] a[href$="/private/${KEY}"]`).count()) >
				0
		);
		check(
			'the page says the link is the invitation',
			/link is the invitation/i.test(await text(pages.bob, '[data-testid=link-is-invitation]'))
		);
		await listLoads(pages.mallory, 'mallory');
		check('mallory: not listed', !(await text(pages.mallory, 'main')).includes(NAME));
	});

	step('12. alice removes dana, who loses it at once, then lets her back', async () => {
		const a = pages.alice;
		await open(a);
		check('she is on alice’s attendees before', await inAttendees(a, 'interested', P.dana.handle));
		await guestRow(a, 'dana')
			.getByRole('button', { name: /remove/i })
			.click();
		await guestRow(a, 'dana').waitFor({ state: 'detached', timeout: 20000 });
		const d = pages.dana;
		const status = await open(d);
		check('dana gets a 404 right after', status === 404, `${status}`);
		await sameAsMadeUp('dana', d, 'dana, removed, on another PDS');
		check('her record stays in her repo', (await ownRsvp('dana')) === 'interested');
		await a.reload({ waitUntil: 'load' });
		await settle(a);
		check('she is off alice’s attendees', !(await inAttendees(a, 'interested', P.dana.handle)));
		check('and off alice’s page', !(await text(a, 'main')).includes(P.dana.handle));
		await addGuest(a, P.dana.handle);
		await guestRow(a, 'dana').waitFor({ timeout: 20000 });
		check(
			'back on the list, not answered yet',
			/hasn't answered/.test(await guestRow(a, 'dana').innerText())
		);
		const back = await open(d);
		check('dana reads it again', back === 200, `${back}`);
		check(
			'and is asked to answer again',
			/Answer to let the host know/.test(await text(d, '[data-testid=private-note]'))
		);
		check('her new answer lands', await answer(d, /^going$/i, 'dana', 'going'));
		await a.reload({ waitUntil: 'load' });
		await settle(a);
		await guestRow(a, 'dana').waitFor({ timeout: 20000 });
		check(
			'alice sees her new answer, not the old one',
			/\bGoing\b/.test(await guestRow(a, 'dana').innerText())
		);
	});

	step('13. alice edits the event, under a page open from before the edit', async () => {
		const a = pages.alice;
		await open(a);
		await addGuest(a, P.mallory.handle);
		await guestRow(a, 'mallory').waitFor({ timeout: 20000 });
		const stale = pages.mallory;
		await open(stale);
		await stale.getByRole('heading', { name: NAME }).first().waitFor({ timeout: 20000 });
		await a.getByRole('link', { name: /edit/i }).first().click({ timeout: 20000 });
		await a.waitForURL((u) => u.pathname.endsWith('/edit'), { timeout: 30000 });
		const name = a.locator('main [contenteditable=true]').first();
		await name.waitFor({ timeout: 30000 });
		await name.click();
		await a.keyboard.press('End');
		await a.keyboard.type(' at eight');
		await shot(a, '10-edit');
		await a
			.getByRole('button', { name: /^(save|update|publish)/i })
			.first()
			.click();
		await a.waitForURL((u) => !u.pathname.endsWith('/edit'), { timeout: 30000 });
		await a.waitForLoadState('load');
		await open(pages.bob);
		await pages.bob.getByRole('heading', { name: RENAMED }).first().waitFor({ timeout: 20000 });
		check('bob sees the new name', (await text(pages.bob, 'main')).includes(RENAMED));
		check('bob’s answer still stands', (await ownRsvp('bob')) === 'going');
		check('still 0 events in her public repo', (await publicCount('alice', EVENT)) === 0);
		await stale
			.getByRole('button', { name: /^going$/i })
			.first()
			.click({ timeout: 20000 });
		await stale.getByRole('heading', { name: RENAMED }).first().waitFor({ timeout: 20000 });
		check('the old page’s answer was refused', (await ownRsvp('mallory')) === null);
		check(
			'and she can answer without reloading',
			await answer(stale, /^going$/i, 'mallory', 'going')
		);
	});

	step('14. a plain login in a second browser, then alice’s own page', async () => {
		const second = await pageFor('alice-2');
		await signIn(second, P.alice);
		await second.context().close();
		const a = pages.alice;
		const status = await open(a);
		check('her own event is not a 404', status === 200, `${status}`);
		await a.locator('[data-testid=grant-notice]').waitFor({ timeout: 20000 });
		await shot(a, '11-host-regrant');
		await allow(a, /allow atmo again/i, P.alice);
		await a.getByRole('heading', { name: RENAMED }).first().waitFor({ timeout: 30000 });
		check(
			'allowed again, she sees it and its guests',
			(await a.locator('[data-testid=guest-list]').count()) === 1
		);
		const b = await open(pages.bob);
		check('guests kept reading throughout', b === 200, `${b}`);
	});

	step(
		'14b. nothing reached the public network or atmo, and a public event did',
		async () => {
			const control = await C.mallory.write(EVENT, {
				name: PUBLIC_NAME,
				startsAt: new Date(Date.now() + 7 * 86400000).toISOString(),
				createdAt: new Date().toISOString(),
				mode: `${EVENT}#inperson`,
				status: `${EVENT}#scheduled`
			});
			const controlKey = control.uri.split('/').at(-1) ?? '';

			// Not the space type's name: its lexicon is a public record on purpose.
			const needles = [NAME, RENAMED, KEY, SPACE];

			// What anyone can read from the public firehose: everything from the start of the network.
			const seen = await new Promise<{
				messages: number;
				control: boolean;
				leaks: string[];
				collections: Record<string, number>;
				notControls: number;
			}>((resolve, reject) => {
				const ws = new WebSocket(`${JETSTREAM.replace(/^http/, 'ws')}/subscribe?cursor=0`);
				const found = {
					messages: 0,
					control: false,
					leaks: [] as string[],
					collections: {} as Record<string, number>,
					notControls: 0
				};
				let quiet: ReturnType<typeof setTimeout> | undefined;
				const finish = () => {
					ws.close();
					resolve(found);
				};
				const giveUp = setTimeout(finish, 60000);
				ws.addEventListener('error', () => {
					clearTimeout(giveUp);
					clearTimeout(quiet);
					reject(new Error('jetstream connection failed'));
				});
				ws.addEventListener('message', async (m) => {
					const data: unknown = m.data;
					const raw = typeof data === 'string' ? data : await (data as Blob).text();
					found.messages++;
					const message = JSON.parse(raw) as { did?: string; commit?: { collection?: string } };
					const c = message.commit?.collection;
					if (c) found.collections[c] = (found.collections[c] ?? 0) + 1;
					// From the start of the network, so an earlier run's control shows too. Those are mallory's.
					if (c === EVENT && message.did !== C.mallory.did) found.notControls++;
					if (raw.includes(PUBLIC_NAME)) found.control = true;
					for (const n of needles) if (raw.includes(n)) found.leaks.push(n);
					clearTimeout(quiet);
					quiet = setTimeout(() => (found.control ? (clearTimeout(giveUp), finish()) : null), 3000);
				});
			});
			log(`  jetstream: ${seen.messages} messages, ${JSON.stringify(seen.collections)}`);
			check('the public event is on the firehose, so the firehose works', seen.control);
			check(
				'nothing of the private event is on it',
				seen.leaks.length === 0,
				seen.leaks.join(', ')
			);
			check(
				'the only events on it are public controls',
				seen.notControls === 0,
				`${seen.notControls} of ${seen.collections[EVENT]}`
			);
			check('no RSVP on it at all', !seen.collections[RSVP], `${seen.collections[RSVP] ?? 0}`);

			// A repo's public export, raw, where a record's text sits as it was written.
			const exported = async (c: Checker) => {
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
			for (const name of ['alice', 'bob', 'dana'] as const) {
				const repo = await exported(C[name]);
				const leaks = needles.filter((needle) => repo.includes(needle));
				check(`nothing of it in ${name}’s exported repo`, leaks.length === 0, leaks.join(', '));
			}

			// atmo's own index, after real ingest. Each run reads the network's Jetstream for up to 20 s.
			let indexed: { value?: { name?: string } } | null = null;
			for (let i = 0; i < 6 && !indexed; i++) {
				await cron();
				const r = await fetch(`${ATMO}/p/${C.mallory.handle}/e/${controlKey}/data.json`);
				if (r.ok) indexed = (await r.json()) as { value?: { name?: string } };
				else if (r.status !== 404) throw new Error(`atmo's event data: ${r.status}`);
			}
			check('atmo indexed the public event, so ingest works', indexed?.value?.name === PUBLIC_NAME);
			const hidden = await fetch(`${ATMO}/p/${C.alice.handle}/e/${KEY}/data.json`);
			check(
				'atmo has no public copy of the private event',
				hidden.status === 404,
				`${hidden.status}`
			);
			const listing = await pages.mallory.request.get(`${ATMO}/events?filter=all`);
			const html = await listing.text();
			check('/events loaded', listing.status() === 200, `${listing.status()}`);
			check('/events shows the public event', html.includes(PUBLIC_NAME));
			check('/events has nothing of the private one', !html.includes(NAME) && !html.includes(KEY));
			const profile = await pages.mallory.request.get(`${ATMO}/p/${C.alice.handle}`);
			const publicPage = await profile.text();
			check('alice’s public page loaded', profile.status() === 200, `${profile.status()}`);
			check(
				'alice’s public page has nothing of it',
				!publicPage.includes(NAME) && !publicPage.includes(KEY)
			);
		},
		// Up to a minute on the firehose, then up to six runs of atmo's cron at 20 s each.
		300_000
	);

	step('15. alice cancels, and a guest gets the same page as anyone', async () => {
		const a = pages.alice;
		await open(a, `${EVENT_PATH}/edit`);
		await a
			.getByRole('button', { name: /^delete/i })
			.first()
			.click({ timeout: 20000 });
		const confirm = a.getByRole('button', { name: /^delete/i }).last();
		await confirm.click({ timeout: 10000 }).catch(() => {});
		await a.waitForURL((u) => u.pathname === '/private', { timeout: 30000 });
		await listLoads(a, 'alice');
		check('off her list', !(await text(a, 'main')).includes(NAME));
		const status = await open(pages.bob);
		check('bob gets a 404, not a 500', status === 404, `${status}`);
		check('in the same words', (await text(pages.bob, 'main')).includes(NOT_AVAILABLE));
		await shot(pages.bob, '12-guest-after-cancel');
		await sameAsMadeUp('bob', pages.bob, 'bob, after the cancel');
		check('his record stays in his repo', (await ownRsvp('bob')) === 'going');
		await listLoads(pages.bob, 'bob');
		check('off bob’s list', !(await text(pages.bob, 'main')).includes(NAME));
	});

	step('16. no uncaught error in any browser', async () => {
		check('no uncaught error in any browser', pageErrors === 0, `${pageErrors}`);
	});
});

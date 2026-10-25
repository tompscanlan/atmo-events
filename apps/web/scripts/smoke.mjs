// A read-only smoke check for a running atmo, safe against production: it reads
// public pages, starts a sign-in up to the account server's own sign-in page and
// stops there, and writes nothing. A handful of requests, so it can run anytime.
//
//   node scripts/smoke.mjs                       # atmo.rsvp
//
//   SMOKE_URL=https://atmo.lighthouse.snowglobe.at \
//   SMOKE_HANDLE=bob.lighthouse.snowglobe.at SMOKE_OUTSIDE_HANDLE=bsky.app \
//   SMOKE_HOSTS=lighthouse.snowglobe.at node scripts/smoke.mjs   # a sealed globe
//
// On a globe, atmo is at atmo.<globe>; the bare globe name serves nothing.
// Playwright is not a dependency of this app: install it beside the script's
// caller, or point SMOKE_PLAYWRIGHT at an installed copy's index.mjs.
//
// Settings (environment):
//   SMOKE_URL             the atmo to check (default https://atmo.rsvp)
//   SMOKE_HANDLE          an account on that network whose sign-in should start
//                         (default bsky.app)
//   SMOKE_MISSING_HANDLE  a handle nobody holds, which should fail cleanly
//                         (default a random name under bsky.social)
//   SMOKE_OUTSIDE_HANDLE  a handle from outside a sealed network, which should
//                         fail cleanly instead of hanging (unset: not checked)
//   SMOKE_HOSTS           comma-separated domains the browser may ask; any other
//                         host fails the run (unset: hosts are listed, not checked)
//   SMOKE_PLAYWRIGHT      the playwright package (default: `playwright`)
//   SMOKE_DEVICE          check from an emulated phone, by Playwright device name,
//                         e.g. 'Pixel 7' (unset: a desktop browser)
//
// Exit 0 when every check passes, 1 otherwise. Each check prints PASS or FAIL
// with what it saw.

const SITE = (process.env.SMOKE_URL ?? 'https://atmo.rsvp').replace(/\/+$/, '');
const HANDLE = process.env.SMOKE_HANDLE ?? 'bsky.app';
const MISSING =
	process.env.SMOKE_MISSING_HANDLE ?? `no-such-${Date.now().toString(36)}.bsky.social`;
const OUTSIDE = process.env.SMOKE_OUTSIDE_HANDLE;
const HOSTS = (process.env.SMOKE_HOSTS ?? '')
	.split(',')
	.map((h) => h.trim().toLowerCase())
	.filter(Boolean);
/** How long a sign-in that should fail may take to say so. */
const FAIL_WITHIN_MS = 20_000;

const { chromium, devices } = await import(process.env.SMOKE_PLAYWRIGHT ?? 'playwright');
const DEVICE = process.env.SMOKE_DEVICE;
if (DEVICE && !devices[DEVICE])
	throw new Error(`SMOKE_DEVICE: Playwright has no device '${DEVICE}'`);

const results = [];
function check(name, ok, detail) {
	results.push({ name, ok });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`);
}

const browser = await chromium.launch();
const context = await browser.newContext(DEVICE ? devices[DEVICE] : {});
if (DEVICE)
	console.log(`checking from ${DEVICE} (${devices[DEVICE].viewport.width}px wide, touch)`);
const asked = new Map();
const pageErrors = [];
context.on('request', (r) => {
	const host = new URL(r.url()).host;
	if (host) asked.set(host, (asked.get(host) ?? 0) + 1);
});

/** A page with the app hydrated, so its buttons work. */
async function open(path) {
	const page = await context.newPage();
	page.on('pageerror', (e) => pageErrors.push(`${path}: ${e.message.slice(0, 160)}`));
	const res = await page.goto(`${SITE}${path}`, { waitUntil: 'networkidle', timeout: 30_000 });
	return { page, status: res?.status() ?? 0 };
}

/** Opens the login dialog, types `handle` and presses Login. Resolves to where
 *  the browser ended up, or the dialog's message when it stayed on the site. */
async function startSignIn(handle) {
	const { page } = await open('/');
	await page.getByRole('button', { name: 'Login' }).first().click();
	const input = page.locator('input[name=atproto-handle]');
	await input.waitFor({ timeout: 10_000 });
	await input.fill(handle);
	const started = Date.now();
	await input.press('Enter');
	const siteHost = new URL(SITE).host;
	let left = false;
	let message = '';
	// Short waits on each read: once the browser leaves for the account server the
	// dialog is gone, and a default (30 s) wait would outlast the whole budget.
	for (;;) {
		if (new URL(page.url()).host !== siteHost) {
			left = true;
			break;
		}
		if (Date.now() - started >= FAIL_WITHIN_MS) break;
		const button = await page
			.locator('input[name=atproto-handle]')
			.locator('xpath=following::button[1]')
			.innerText({ timeout: 500 })
			.catch(() => '');
		const text = await page
			.locator('body')
			.innerText({ timeout: 500 })
			.catch(() => '');
		const m = /failed to resolve[^\n"]*/i.exec(text) ?? /could not[^\n"]*/i.exec(text);
		if (m && !/loading/i.test(button)) {
			message = m[0];
			break;
		}
		await page.waitForTimeout(250);
	}
	const result = { left, url: page.url().split('?')[0], message, ms: Date.now() - started };
	await page.close();
	return result;
}

try {
	// s1: the home page renders.
	{
		const { page, status } = await open('/');
		const title = await page.title();
		check('home page', status === 200 && title.length > 0, `status ${status}, title "${title}"`);
		await page.close();
	}

	// s2: the OAuth client metadata names this site.
	{
		const res = await fetch(`${SITE}/oauth-client-metadata.json`);
		const meta = await res.json().catch(() => null);
		const id = `${SITE}/oauth-client-metadata.json`;
		const redirects = meta?.redirect_uris ?? [];
		check(
			'client metadata',
			res.ok &&
				meta?.client_id === id &&
				redirects.length > 0 &&
				redirects.every((u) => u.startsWith(`${SITE}/`)) &&
				String(meta?.scope ?? '')
					.split(' ')
					.includes('atproto'),
			`status ${res.status}, client_id ${meta?.client_id}, redirects ${JSON.stringify(redirects)}`
		);
	}

	// s3, s4: the events page lists events, and one opens with its images loaded.
	// The All tab: the default Popular tab is empty on a small network.
	{
		const { page, status } = await open('/events?filter=all');
		const links = [
			...new Set(await page.$$eval('a[href*="/e/"]', (as) => as.map((a) => a.getAttribute('href'))))
		].filter((h) => h && /\/p\/[^/]+\/e\/[^/]+$/.test(h));
		check('events page', status === 200, `status ${status}, ${links.length} event links`);
		await page.close();
		if (links.length === 0) {
			check('event page', true, 'skipped: no events listed');
		} else {
			const { page: ev, status: evStatus } = await open(links[0]);
			const heading = await ev
				.locator('h1')
				.first()
				.innerText()
				.catch(() => '');
			const images = await ev.$$eval('img', (is) =>
				is
					.filter((i) => i.src && !i.src.startsWith('data:'))
					.map((i) => ({ src: i.src.slice(0, 100), ok: i.complete && i.naturalWidth > 0 }))
			);
			const broken = images.filter((i) => !i.ok);
			check(
				'event page',
				evStatus === 200 && heading.length > 0 && broken.length === 0,
				`${links[0]}: status ${evStatus}, heading "${heading.slice(0, 60)}", ${images.length} images, broken ${JSON.stringify(broken)}`
			);
			await ev.close();
		}
	}

	// s5: a sign-in starts and reaches the account server's own page. Nothing is submitted there.
	{
		const r = await startSignIn(HANDLE);
		check(
			'sign-in starts',
			r.left && /\/oauth\/authorize$/.test(r.url),
			`${HANDLE}: ${r.left ? `reached ${r.url}` : `stayed on the site (${r.message || 'no message'})`} in ${r.ms} ms`
		);
	}

	// s6: a handle nobody holds fails with a message, not a spinner.
	{
		const r = await startSignIn(MISSING);
		check(
			'unknown handle fails cleanly',
			!r.left && r.message.length > 0,
			`${MISSING}: ${r.message || (r.left ? `left for ${r.url}` : 'no message')} in ${r.ms} ms`
		);
	}

	// s7: on a sealed network, an outside handle also fails with a message.
	if (OUTSIDE) {
		const r = await startSignIn(OUTSIDE);
		check(
			'outside handle fails cleanly',
			!r.left && r.message.length > 0,
			`${OUTSIDE}: ${r.message || (r.left ? `left for ${r.url}` : 'no message')} in ${r.ms} ms`
		);
	}

	// s8: no script errors on any page opened.
	check('no page errors', pageErrors.length === 0, JSON.stringify(pageErrors));

	// s9: the hosts the browser asked.
	{
		const hosts = [...asked.keys()].sort();
		const allowed = (h) => HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
		const stray = HOSTS.length ? hosts.filter((h) => !allowed(h)) : [];
		check(
			'hosts asked',
			stray.length === 0,
			HOSTS.length
				? `outside ${HOSTS.join(', ')}: ${JSON.stringify(stray)}`
				: `not checked: ${hosts.join(', ')}`
		);
	}
} catch (e) {
	check('run', false, e instanceof Error ? e.message : String(e));
} finally {
	await browser.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} pass against ${SITE}`);
process.exit(failed ? 1 : 0);

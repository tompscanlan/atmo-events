// Walk checks on a seeded globe's atmo, acting as the seeded people (seed.mjs) in a real
// browser. Run through seed.sh, which supplies the logins:
//
//   deploy/snowglobe/seed.sh <globe> walk.mjs
//
// Each check prints PASS or FAIL with what it saw; exit 0 when all pass. Writes nothing
// lasting: a refused sign-in makes nothing.
//
//   w1  jojo signs in to atmo and presses Deny access at their own account server: the
//       browser comes back to atmo, nothing along the way answers 5xx, and jojo is not
//       signed in
//   w2  jojo starts a group at the group host and presses Deny access at their own account
//       server: the browser comes back to atmo's create page with its error, nothing along
//       the way answers 5xx (the host's sign-in callback included), and no group is made

import {
	ATMO,
	DOMAIN,
	asPerson,
	chromium,
	closeBrowser,
	handleOf,
	log,
	ownPdsPages,
	shot,
	where
} from './seed.mjs';

const results = [];
function check(id, ok, detail) {
	results.push(ok);
	log(`${ok ? 'PASS' : 'FAIL'}  ${id}: ${detail}`);
}

const atmoHost = new URL(ATMO).host;
const onAtmo = (page) => new URL(page.url()).host === atmoHost;

/** Every 5xx a page's requests got, anywhere on the way. */
function watch5xx(context) {
	const bad = [];
	context.on('response', (r) => {
		if (r.status() >= 500) {
			const u = new URL(r.url());
			bad.push(`${r.status()} ${u.host}${u.pathname}`);
		}
	});
	return bad;
}

async function w1() {
	const context = await (await chromium()).newContext();
	const bad = watch5xx(context);
	const page = await context.newPage();
	try {
		await page.goto(`${ATMO}/`, { waitUntil: 'networkidle' });
		await page.getByRole('button', { name: 'Login' }).first().click();
		const input = page.locator('input[name=atproto-handle]');
		await input.waitFor({ timeout: 10_000 });
		await input.fill(handleOf('jojo'));
		await input.press('Enter');
		await page.waitForURL((u) => u.host !== atmoHost, { timeout: 20_000 });
		await ownPdsPages(page, 'jojo', async () => onAtmo(page), { refuse: true });
		await page.waitForLoadState('networkidle');
		const loginShown = await page
			.getByRole('button', { name: 'Login' })
			.first()
			.isVisible()
			.catch(() => false);
		check(
			'w1 deny at sign-in',
			onAtmo(page) && bad.length === 0 && loginShown,
			`ended at ${where(page)}, 5xx ${JSON.stringify(bad)}, signed out ${loginShown}`
		);
	} catch (e) {
		await shot(page, 'w1');
		check('w1 deny at sign-in', false, `${e.message} (at ${where(page)})`);
	} finally {
		await context.close();
	}
}

async function w2() {
	const label = `cancel${Date.now().toString(36)}`;
	const context = await asPerson('jojo');
	const bad = watch5xx(context);
	const page = await context.newPage();
	try {
		await page.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await page.fill('#group-name', 'Cancelled group');
		await page.getByRole('button', { name: 'Create group' }).click();
		await page.waitForURL((u) => u.host !== atmoHost, { timeout: 30_000 });
		await page.waitForSelector('input[name=handle]', { timeout: 30_000 });
		await page.fill('input[name=label]', label);
		await page.fill('input[name=handle]', handleOf('jojo'));
		await page.click('button');
		await ownPdsPages(page, 'jojo', async () => onAtmo(page), { refuse: true });
		await page.waitForLoadState('networkidle');
		const url = new URL(page.url());
		const res = await fetch(`https://${label}.gh.${DOMAIN}/.well-known/atproto-did`).catch(
			() => null
		);
		const made = !!res?.ok && (await res.text()).trim().startsWith('did:');
		check(
			'w2 deny at group create',
			url.pathname === '/groups/create' &&
				url.searchParams.has('error') &&
				bad.length === 0 &&
				!made,
			`ended at ${where(page)} (error shown: ${url.searchParams.has('error')}), 5xx ${JSON.stringify(bad)}, group ${label} made ${made}`
		);
	} catch (e) {
		await shot(page, 'w2');
		check('w2 deny at group create', false, `${e.message} (at ${where(page)})`);
	} finally {
		await page.close();
	}
}

try {
	await w1();
	await w2();
} finally {
	await closeBrowser();
}
const failed = results.filter((ok) => !ok).length;
log(`\n${results.length - failed}/${results.length} pass against ${ATMO}`);
process.exit(failed ? 1 : 0);

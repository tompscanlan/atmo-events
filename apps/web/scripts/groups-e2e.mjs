#!/usr/bin/env node
/**
 * atmo's groups, end to end, on the groups snowglobe: `pnpm globe:dev` in one terminal, then
 * `pnpm globe:e2e` in another.
 *
 * Three people sign in for real through their own PDS (owner, member, outsider), in a Chromium
 * on the globe, and use atmo the way a person does. Each run makes its own group at the group host
 * and leaves it behind. Every check prints one PASS or FAIL line; a clean run ends
 * `SUMMARY: N passed, 0 failed`. Writes are confirmed by reading them back, from the group host's
 * repo or from a fresh page load, never from what a page said right after a click.
 *
 * The host shows a new group's recovery key (its PLC rotation key, a private key) once, right after
 * it is made. This script never screenshots, logs or reads that page; it only clicks Continue.
 */
import { createRequire } from 'node:module';

const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is not set. Run this with pnpm globe:e2e.`);
		process.exit(2);
	}
	return value;
}

const ATMO = required('E2E_ATMO');
const GROUP_HOST = required('E2E_GROUP_HOST');
const person = (role) => ({
	role,
	handle: required(`E2E_${role}_HANDLE`),
	password: required(`E2E_${role}_PASSWORD`)
});
const OWNER = person('OWNER');
const MEMBER = person('MEMBER');
const OUTSIDER = person('OUTSIDER');

const RUN = Date.now().toString(36);
const GROUP_NAME = `Trail club ${RUN}`;
const PUBLIC_EVENT = `Trail day ${RUN}`;
const MEMBERS_EVENT = `Members' walk ${RUN}`;

let passed = 0;
let failed = 0;
function check(ok, label, detail) {
	console.log(
		`${ok ? 'PASS' : 'FAIL'} ${passed + failed + 1}. ${label}${!ok && detail ? `: ${detail}` : ''}`
	);
	if (ok) passed++;
	else failed++;
	return ok;
}

const text = async (page) => (await page.locator('main').innerText()).replace(/\s+/g, ' ');
const buttons = async (page) =>
	(await page.locator('main').getByRole('button').allInnerTexts()).map((t) => t.trim());
const settle = (page) => page.waitForLoadState('networkidle').catch(() => {});

/** Walks the PDS and group-host pages a click led to until the browser is back on atmo. */
async function walk(page, who, label) {
	const away = (u) => !u.href.startsWith(ATMO);
	await page.waitForURL(away, { timeout: 30_000 });
	const gone = (locator) => locator.waitFor({ state: 'detached', timeout: 45_000 });
	for (let step = 0; step < 12; step++) {
		await settle(page);
		if (!away(new URL(page.url()))) return;
		if (await page.locator('#recovery').count()) {
			await page.click('#continue');
			await gone(page.locator('#recovery'));
		} else if (await page.locator('input[name=password]').count()) {
			const user = page.locator('input[name=username]');
			if ((await user.count()) && (await user.isEditable())) await user.fill(who.handle);
			await page.fill('input[name=password]', who.password);
			await page.getByRole('button', { name: /sign in/i }).click();
			await gone(page.locator('input[name=password]'));
		} else if (await page.locator('#consent').count()) {
			await page.click('#go');
			await gone(page.locator('#consent'));
		} else if (await page.getByRole('button', { name: /^authorize$/i }).count()) {
			await page.getByRole('button', { name: /^authorize$/i }).click();
			await gone(page.getByRole('button', { name: /^authorize$/i }));
		} else if (label && (await page.locator('input[name=label]').count())) {
			await page.fill('input[name=label]', label);
			if (await page.locator('input[name=handle]').count())
				await page.fill('input[name=handle]', who.handle);
			await page.locator('form button').first().click();
			await gone(page.locator('input[name=label]'));
		} else if (await page.locator('form input[name=handle]').count()) {
			// The host's page to act as a group that exists: who you are, then your own PDS.
			await page.fill('input[name=handle]', who.handle);
			await page.locator('form button').first().click();
			await gone(page.locator('input[name=handle]'));
		} else {
			const { origin, pathname } = new URL(page.url());
			throw new Error(`a page this script does not know: ${origin}${pathname}`);
		}
	}
	throw new Error('never got back to atmo');
}

async function signIn(browser, who, again = '') {
	const page = await (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	await page.goto(`${ATMO}/`, { waitUntil: 'networkidle' });
	await page
		.getByRole('button', { name: /^log in$/i })
		.first()
		.click();
	await page.fill('input[name=handle]', who.handle);
	await page
		.getByRole('button', { name: /^log in/i })
		.last()
		.click();
	await page.getByRole('button', { name: /^continue to log in/i }).click();
	await walk(page, who);
	await settle(page);
	check(
		(await page.getByRole('button', { name: /^log in$/i }).count()) === 0,
		`${who.role.toLowerCase()} signs in through their PDS${again}`
	);
	return page;
}

/** The person's group permissions, asked for at their first group action ("See your groups"). */
async function allowGroups(page, who, groupUrl) {
	await page.goto(groupUrl, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: /^see your groups$/i }).click();
	await walk(page, who);
	await page.goto(groupUrl, { waitUntil: 'networkidle' });
}

async function postEvent(page, groupDid, placement, name) {
	await page.goto(`${ATMO}/groups/${groupDid}/events/new`, { waitUntil: 'networkidle' });
	await page.locator(`input[name=placement][value=${placement}]`).check();
	await page.locator('main [contenteditable=true]').first().click();
	await page.keyboard.type(name);
	await page.getByRole('button', { name: /^Start date/ }).click();
	await page.keyboard.press('ArrowRight'); // tomorrow, so the event is upcoming
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: /^publish event$/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 45_000 });
	await settle(page);
	return new URL(page.url()).pathname.split('/').pop();
}

async function saveSettings(page, groupDid, { visibility, listed = false }) {
	await page.goto(`${ATMO}/groups/${groupDid}/settings`, { waitUntil: 'networkidle' });
	await page.locator(`input[name=visibility][value=${visibility}]`).check();
	if (listed) await page.locator('input[name=listed]').check();
	await page.getByRole('button', { name: /^save$/i }).click();
	await page.waitForURL((u) => !u.pathname.endsWith('/settings'), { timeout: 60_000 });
	await settle(page);
}

async function groupRepoEvents(groupDid) {
	const url = `${GROUP_HOST}/xrpc/com.atproto.repo.listRecords?repo=${groupDid}&collection=community.lexicon.calendar.event`;
	const body = await (await fetch(url)).json();
	return (body.records ?? []).map((r) => ({ rkey: r.uri.split('/').pop(), name: r.value?.name }));
}

async function main() {
	const health = await fetch(`${ATMO}/`).catch(() => null);
	if (!health?.ok) {
		console.error(`atmo does not answer at ${ATMO}. Start it with pnpm globe:dev first.`);
		process.exit(2);
	}
	const browser = await chromium.launch();
	const visitor = async () => (await browser.newContext({ ignoreHTTPSErrors: true })).newPage();
	try {
		const owner = await signIn(browser, OWNER);
		const member = await signIn(browser, MEMBER);
		const outsider = await signIn(browser, OUTSIDER);

		// The group, made at the host's own sign-up and set up by atmo after it.
		await owner.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await owner.fill('input[name=name]', GROUP_NAME);
		await owner.fill('textarea[name=description]', 'A group made by the groups e2e.');
		await owner.check('input[name=listed]');
		await owner.getByRole('button', { name: /continue to the group host/i }).click();
		await walk(owner, OWNER, `e2e${RUN}`);
		await settle(owner);
		const groupDid = /\/groups\/(did:[^/]+)$/.exec(new URL(owner.url()).pathname)?.[1];
		if (
			!check(
				Boolean(groupDid) && (await text(owner)).includes(GROUP_NAME),
				'the owner makes a group at the host and lands on its page',
				owner.url()
			)
		)
			return;
		const groupUrl = `${ATMO}/groups/${groupDid}`;
		console.log(`note: the group is ${groupDid}`);
		const anon = await visitor();
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			(await anon.getByText(GROUP_NAME).count()) > 0,
			'a listed public group shows on the groups page, signed out'
		);

		// A public event, written as the group into its own repo.
		const publicRkey = await postEvent(owner, groupDid, 'everyone', PUBLIC_EVENT);
		check(
			(await groupRepoEvents(groupDid)).some(
				(e) => e.rkey === publicRkey && e.name === PUBLIC_EVENT
			),
			"a public event lands in the group's repo at the host"
		);
		await anon.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			(await anon.getByText(PUBLIC_EVENT).count()) > 0,
			"the group's public event shows on its page, signed out"
		);

		// Joining: the member's group permissions, a request, the owner's approval, the visit.
		await allowGroups(member, MEMBER, groupUrl);
		// The page holds a sent request only until it is reloaded: no lexicon lets a person read their
		// own pending request back, and atmo keeps no table of them. Check 9 reads it at the host.
		await member.getByRole('button', { name: /^ask to join$/i }).click();
		await member
			.getByRole('button', { name: /^withdraw$/i })
			.waitFor({ timeout: 30_000 })
			.catch(() => {});
		check(
			(await buttons(member)).some((b) => /^withdraw$/i.test(b)),
			'the member asks to join'
		);
		await allowGroups(owner, OWNER, groupUrl);
		await owner.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		const asking = (await text(owner)).includes(MEMBER.handle);
		await owner.getByRole('button', { name: /^approve$/i }).click();
		await settle(owner);
		check(asking, "the owner sees the request on the group's members page and approves it");
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			(await buttons(member)).some((b) => /^leave group$/i.test(b)),
			'the member is a member on their next visit'
		);
		await owner.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		check(
			!(await text(owner)).includes('Not confirmed yet'),
			'the visit confirms the member on the roster'
		);

		await owner.goto(`${groupUrl}/settings`, { waitUntil: 'networkidle' });
		check(
			await owner.locator('input[name=listed]').isChecked(),
			"the settings form shows the group's listing as it is"
		);

		// Members-only events, in the group's calendar space.
		await allowGroups(outsider, OUTSIDER, groupUrl);
		const membersRkey = await postEvent(owner, groupDid, 'members', MEMBERS_EVENT);
		check(
			!(await groupRepoEvents(groupDid)).some((e) => e.rkey === membersRkey),
			"a members-only event stays out of the group's public repo"
		);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			(await member.getByText(MEMBERS_EVENT).count()) > 0,
			'the member sees the members-only event'
		);
		for (const [who, page] of [
			['an outsider with group permissions', outsider],
			['a signed-out visitor', anon]
		]) {
			await page.goto(groupUrl, { waitUntil: 'networkidle' });
			const listed = await page.getByText(MEMBERS_EVENT).count();
			const direct = await page.goto(`${groupUrl}/events/${membersRkey}`, {
				waitUntil: 'networkidle'
			});
			check(
				listed === 0 && direct?.status() === 404,
				`${who} never sees the members-only event`,
				`listed ${listed}, its page ${direct?.status()}`
			);
		}
		await member.goto(`${groupUrl}/events/${membersRkey}`, { waitUntil: 'networkidle' });
		await member
			.getByRole('button', { name: /^going$/i })
			.first()
			.click();
		await settle(member);
		await member.reload({ waitUntil: 'networkidle' });
		check((await text(member)).includes("You're Going"), "the member's RSVP to it holds");

		// Members only, and public again.
		await saveSettings(owner, groupDid, { visibility: 'private' });
		const privateAnon = await anon.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			privateAnon?.status() === 404,
			'a members-only group is not found, signed out',
			String(privateAnon?.status())
		);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			(await member.getByText(MEMBERS_EVENT).count()) > 0,
			'the member still sees it, members-only event included'
		);
		await anon.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		check(
			(await anon.getByText(GROUP_NAME).count()) === 0,
			'a members-only group leaves the groups page'
		);
		// Signed out, atmo shows only a declared (listed) group until public meta reads land.
		await saveSettings(owner, groupDid, { visibility: 'public', listed: true });
		const publicAgain = await anon.goto(groupUrl, { waitUntil: 'networkidle' });
		const eventShown = await anon.getByText(PUBLIC_EVENT).count();
		check(
			publicAgain?.status() === 200 && eventShown > 0,
			'made public and listed again, it shows signed out',
			`status ${publicAgain?.status()}, event shown ${eventShown}`
		);

		// Linking a group that already exists. A link is kept under the person, not the browser,
		// so the owner unlinks first; then, in a browser that has never seen the group, links it
		// from the groups page and posts as it through the new link. By its DID, not its handle:
		// snowglobe run fixes its names when atmo starts, so a group made during the run has a
		// handle atmo's server cannot resolve on the globe.
		const settingsLink = (page) => page.locator(`main a[href$="/groups/${groupDid}/settings"]`);
		await owner.goto(groupUrl, { waitUntil: 'networkidle' });
		await owner.getByRole('button', { name: /^unlink$/i }).click();
		await owner.waitForURL((u) => u.pathname === '/groups', { timeout: 30_000 });
		await owner.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			(await settingsLink(owner).count()) === 0 &&
				(await owner.getByRole('button', { name: /^link this group$/i }).count()) > 0,
			'the owner unlinks the group'
		);
		const fresh = await signIn(browser, OWNER, ' again, in a fresh browser');
		await fresh.goto(`${ATMO}/groups`, { waitUntil: 'networkidle' });
		await fresh.fill('#group-link', groupDid);
		await fresh.getByRole('button', { name: /^link$/i }).click();
		await walk(fresh, OWNER);
		await settle(fresh);
		const landed = new URL(fresh.url());
		check(
			landed.pathname === `/groups/${groupDid}` &&
				landed.searchParams.get('link') === 'linked' &&
				(await settingsLink(fresh).count()) > 0,
			"linked again from the groups page in a fresh browser, the group is the owner's to run",
			fresh.url()
		);
		const relinkEvent = `Relinked meetup ${RUN}`;
		const relinkRkey = await postEvent(fresh, groupDid, 'everyone', relinkEvent);
		check(
			(await groupRepoEvents(groupDid)).some(
				(e) => e.rkey === relinkRkey && e.name === relinkEvent
			),
			"an event posted through the new link lands in the group's repo"
		);
	} catch (e) {
		check(false, 'the run finished', e instanceof Error ? e.message.split('\n')[0] : String(e));
	} finally {
		await browser.close();
	}
	console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
}

await main();

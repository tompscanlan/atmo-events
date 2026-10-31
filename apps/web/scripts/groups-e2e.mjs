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
const person = (role, name = role.toLowerCase()) => ({
	role,
	name,
	handle: required(`E2E_${role}_HANDLE`),
	password: required(`E2E_${role}_PASSWORD`)
});
const OWNER = person('OWNER');
const MEMBER = person('MEMBER');
const OUTSIDER = person('OUTSIDER');
const NOSPACES = person('NOSPACES', 'a person on a server with no spaces support');

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
		`${who.name} signs in through their PDS${again}`
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

async function fillAndPublish(page, placement, name) {
	await page.locator(`input[name=placement][value=${placement}]`).check();
	await page.locator('main [contenteditable=true]').first().click();
	await page.keyboard.type(name);
	await page.getByRole('button', { name: /^Start date/ }).click();
	await page.keyboard.press('ArrowRight'); // tomorrow, so the event is upcoming
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: /^publish event$/i }).click();
}

async function postEvent(page, groupDid, placement, name) {
	await page.goto(`${ATMO}/groups/${groupDid}/events/new`, { waitUntil: 'networkidle' });
	await fillAndPublish(page, placement, name);
	await page.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 45_000 });
	await settle(page);
	return new URL(page.url()).pathname.split('/').pop();
}

/** For a post that should be refused: how far it got, instead of throwing. */
async function tryPostEvent(page, groupDid, name) {
	const res = await page.goto(`${ATMO}/groups/${groupDid}/events/new`, {
		waitUntil: 'networkidle'
	});
	const status = res?.status();
	if (status !== 200) return { status, published: false };
	await fillAndPublish(page, 'everyone', name);
	const published = await page
		.waitForURL((u) => !u.pathname.endsWith('/events/new'), { timeout: 30_000 })
		.then(
			() => true,
			() => false
		);
	return { status, published };
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

		// Leaving. The host deletes the membership, and atmo asks the host on every visit whether
		// the person is a member, so the members-only events go at once: the cut does not wait for
		// the space credentials atmo holds for them to run out.
		// The members page needs the group permissions. atmo keeps one sign-in per person, so the
		// fresh one replaced the first browser's, and neither holds them until asked again.
		await allowGroups(fresh, OWNER, groupUrl);
		const rosterHas = async (page, who) => {
			const res = await page.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
			if (res?.status() !== 200) throw new Error(`the members page answered ${res?.status()}`);
			return (await text(page)).includes(who.handle);
		};
		const onRoster = await rosterHas(fresh, MEMBER);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		await member.getByRole('button', { name: /^leave group$/i }).click();
		await member
			.getByRole('button', { name: /^ask to join$/i })
			.waitFor({ timeout: 30_000 })
			.catch(() => {});
		await member.reload({ waitUntil: 'networkidle' });
		const offered = await buttons(member);
		check(
			!offered.some((b) => /^leave group$/i.test(b)) &&
				offered.some((b) => /^ask to join$/i.test(b)),
			'the member leaves, and their next visit offers to ask to join again',
			offered.join(', ')
		);
		check(
			onRoster && !(await rosterHas(fresh, MEMBER)),
			"the owner's roster drops them",
			`on the roster before leaving: ${onRoster}`
		);
		const stillListed = await member.getByText(MEMBERS_EVENT).count();
		const stillDirect = await member.goto(`${groupUrl}/events/${membersRkey}`, {
			waitUntil: 'networkidle'
		});
		check(
			stillListed === 0 && stillDirect?.status() === 404,
			'the former member no longer sees the members-only event',
			`listed ${stillListed}, its page ${stillDirect?.status()}`
		);

		// Back in, then removed by the owner. The roster offers Remove only for a member who has
		// confirmed, so the member visits once after the approval.
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		await member.getByRole('button', { name: /^ask to join$/i }).click();
		await member
			.getByRole('button', { name: /^withdraw$/i })
			.waitFor({ timeout: 30_000 })
			.catch(() => {});
		const askingAgain = await rosterHas(fresh, MEMBER);
		await fresh.getByRole('button', { name: /^approve$/i }).click();
		await settle(fresh);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		check(
			askingAgain && (await buttons(member)).some((b) => /^leave group$/i.test(b)),
			'the former member asks again, the owner approves, and they are a member again',
			`request seen ${askingAgain}`
		);

		// Roles. Made an admin, the member links the group and runs it; made a member again, the
		// link they still hold no longer writes as the group. atmo checks no role before a write,
		// so that refusal is the host's.
		const rolePicker = (page, who) => page.getByLabel(`Role of ${who.handle}`, { exact: true });
		const setRole = async (role) => {
			await fresh.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
			await rolePicker(fresh, MEMBER).selectOption(role);
			await settle(fresh);
			await fresh.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
			return rolePicker(fresh, MEMBER).inputValue();
		};
		const promoted = await setRole('admin');
		check(
			promoted === 'admin',
			'the owner makes the member an admin',
			`their role reads ${promoted}`
		);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		await member.getByRole('button', { name: /^link this group$/i }).click();
		await walk(member, MEMBER);
		await settle(member);
		const adminLanded = new URL(member.url());
		await member.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		const adminControls = await rolePicker(member, OWNER).count();
		check(
			adminLanded.searchParams.get('link') === 'linked' && adminControls === 1,
			'the new admin links the group and gets the roster controls',
			`landed on ${adminLanded.pathname}${adminLanded.search}, a role picker for the owner: ${adminControls}`
		);
		const adminEvent = `Admin's picnic ${RUN}`;
		const adminRkey = await postEvent(member, groupDid, 'everyone', adminEvent);
		check(
			(await groupRepoEvents(groupDid)).some((e) => e.rkey === adminRkey && e.name === adminEvent),
			"an event the new admin posts lands in the group's repo"
		);
		const demoted = await setRole('member');
		const demotedPage = await member.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		const demotedControls =
			(await rolePicker(member, OWNER).count()) +
			(await member.getByRole('button', { name: /^(remove|approve)$/i }).count());
		check(
			demoted === 'member' && demotedPage?.status() === 200 && demotedControls === 0,
			'made a member again, they lose the roster controls',
			`their role reads ${demoted}, their members page ${demotedPage?.status()}, roster controls shown ${demotedControls}`
		);
		const refusedEvent = `Not allowed ${RUN}`;
		const attempt = await tryPostEvent(member, groupDid, refusedEvent);
		const landedAnyway = (await groupRepoEvents(groupDid)).some((e) => e.name === refusedEvent);
		check(
			attempt.status < 500 && !attempt.published && !landedAnyway,
			'an event posted through their old link is refused and never reaches the group',
			`the new event page ${attempt.status}, published ${attempt.published}, in the group's repo ${landedAnyway}`
		);

		await fresh.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		const remove = fresh
			.locator('main li', { hasText: MEMBER.handle })
			.getByRole('button', { name: /^remove$/i });
		const removable = (await remove.count()) === 1;
		if (removable) {
			await remove.click();
			await settle(fresh);
		}
		check(
			removable && !(await rosterHas(fresh, MEMBER)),
			'the owner removes them, and the roster drops them',
			`a Remove button for them: ${removable}`
		);
		await member.goto(groupUrl, { waitUntil: 'networkidle' });
		const offeredRemoved = await buttons(member);
		check(
			!offeredRemoved.some((b) => /^leave group$/i.test(b)) &&
				offeredRemoved.some((b) => /^ask to join$/i.test(b)),
			'a removed member is not a member on their next visit',
			offeredRemoved.join(', ')
		);
		const removedListed = await member.getByText(MEMBERS_EVENT).count();
		const removedDirect = await member.goto(`${groupUrl}/events/${membersRkey}`, {
			waitUntil: 'networkidle'
		});
		check(
			removedListed === 0 && removedDirect?.status() === 404,
			'a removed member no longer sees the members-only event',
			`listed ${removedListed}, its page ${removedDirect?.status()}`
		);

		// Someone whose own server has no spaces support, as most servers are today. They sign in
		// and see the group as anyone does; their server cannot grant group permissions, so atmo
		// reads nothing for them. An admin can still add them, and since their server cannot
		// write the confirmation either, the admins' list keeps them as not confirmed yet.
		const carol = await signIn(browser, NOSPACES);
		const seeGroups = () => carol.getByRole('button', { name: /^see your groups$/i });
		const carolVisit = async () => {
			const res = await carol.goto(groupUrl, { waitUntil: 'networkidle' });
			return {
				status: res?.status(),
				publicEvent: await carol.getByText(PUBLIC_EVENT).count(),
				membersEvent: await carol.getByText(MEMBERS_EVENT).count()
			};
		};
		const seen = await carolVisit();
		check(
			seen.status === 200 && seen.publicEvent > 0 && seen.membersEvent === 0,
			'they see the public group as anyone does, and no members-only event',
			JSON.stringify(seen)
		);
		await seeGroups().click();
		await walk(carol, NOSPACES);
		const afterAsking = await carolVisit();
		const asksAgain = await seeGroups().count();
		check(
			afterAsking.status === 200 && asksAgain === 1,
			'asked for group permissions, their server returns without them, and the group still loads',
			`${JSON.stringify(afterAsking)}, asks again ${asksAgain}`
		);
		const rosterPlace = async (who) => {
			const res = await fresh.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
			if (res?.status() !== 200) throw new Error(`the members page answered ${res?.status()}`);
			const [confirmed, unconfirmed = ''] = (await text(fresh)).split('Not confirmed yet');
			if (confirmed.includes(who.handle)) return 'confirmed';
			return unconfirmed.includes(who.handle) ? 'not confirmed yet' : 'absent';
		};
		await fresh.goto(`${groupUrl}/members`, { waitUntil: 'networkidle' });
		await fresh.fill('#add-member', NOSPACES.handle);
		await fresh.getByRole('button', { name: /^add$/i }).click();
		await settle(fresh);
		const added = await rosterPlace(NOSPACES);
		check(
			added === 'not confirmed yet',
			'an admin adds them by handle, and they wait under not confirmed yet',
			added
		);
		const addedVisit = await carolVisit();
		const afterVisit = await rosterPlace(NOSPACES);
		check(
			addedVisit.status === 200 &&
				addedVisit.membersEvent === 0 &&
				afterVisit === 'not confirmed yet',
			'after their visit they are still not confirmed, and the group still loads for them',
			`${JSON.stringify(addedVisit)}, on the roster: ${afterVisit}`
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

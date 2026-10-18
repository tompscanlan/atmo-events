// Seed a globe's atmo with known people, groups of each kind, events and RSVPs, so a
// demo or a walk has someone to sign in as. Run through seed.sh, which reads the
// globe's invite code and earlier logins from the cluster and writes the logins back;
// this file holds no secret and prints none.
//
// Each step looks before it writes, so a rerun only adds what is missing.
//
// Settings (environment):
//   SEED_ATMO         the globe's atmo (https://atmo.<globe>.snowglobe.at)
//   SEED_PDS          the account server the people live on (https://alpha.<globe>.snowglobe.at)
//   SEED_DOMAIN       their handles' domain (<globe>.snowglobe.at)
//   SEED_LOGINS_FILE  env file of SEED_<NAME>_{HANDLE,DID,PASSWORD}; read, and rewritten with
//                     anyone made here (mode 600)
//   SEED_INVITE_FILE  env file holding SEED_INVITE_CODE, for sign-up
//   SEED_ONLY         comma-separated steps to run (default: all), from STEPS below
//   SEED_PLAYWRIGHT   the playwright package (default: `playwright`)
//   SEED_SHOTS        a directory for screenshots of the browser steps (unset: none)
//
// The groups' organizers act as the group only once their account server has learned of it,
// up to 10 minutes after the group is made: a first run on a fresh globe stops at `organize`
// with that reason, and a rerun after the wait carries on.

import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const ATMO = need('SEED_ATMO').replace(/\/+$/, '');
const PDS = need('SEED_PDS').replace(/\/+$/, '');
const DOMAIN = need('SEED_DOMAIN');
const LOGINS_FILE = need('SEED_LOGINS_FILE');
const ONLY = (process.env.SEED_ONLY ?? '').split(',').filter(Boolean);

function need(name) {
	const v = process.env[name];
	if (!v) throw new Error(`${name} is not set`);
	return v;
}

/** The cast. Who belongs where is set by GROUPS; what they do by EVENTS and RSVPS. */
const PEOPLE = [
	{ name: 'ada', displayName: 'Ada Okafor', description: 'Runs the Riverside Runners.' },
	{ name: 'ben', displayName: 'Ben Hollis', description: 'Keeps the Book Circle going.' },
	{ name: 'cleo', displayName: 'Cleo Marsh', description: 'Chairs the Board Room.' },
	{ name: 'dara', displayName: 'Dara Raman', description: 'Co-runs the runners; reads a lot.' },
	{ name: 'eli', displayName: 'Eli Brandt', description: 'Runner and reader.' },
	{ name: 'fay', displayName: 'Fay Lindqvist', description: 'Runs, and sits on the board.' },
	{ name: 'gus', displayName: 'Gus Moreau', description: 'Board member.' },
	{ name: 'hana', displayName: 'Hana Ito', description: 'Waiting to get into the Book Circle.' },
	{ name: 'ivo', displayName: 'Ivo Petrov', description: 'An occasional runner.' },
	{ name: 'jojo', displayName: 'Jo Quinn', description: 'In no group; goes to open events.' }
];

/** A personal event's or a public RSVP's record key is fixed, so a rerun overwrites it. */
const DAY = 24 * 3600 * 1000;
function at(days, hour) {
	const d = new Date(Date.now() + days * DAY);
	d.setUTCHours(hour, 0, 0, 0);
	return d.toISOString();
}

/** Personal events, in each author's own repo. */
const PERSONAL_EVENTS = [
	{
		author: 'ada',
		rkey: 'seed-picnic',
		name: 'Picnic in the park',
		description: 'Bring something to share. Blankets by the bandstand.',
		startsAt: at(9, 16),
		endsAt: at(9, 19),
		mode: 'inperson',
		location: {
			street: 'Bandstand, Riverside Park',
			locality: 'Louisville',
			region: 'KY',
			country: 'US'
		},
		image: { text: 'Picnic', color: '#3a7d44' }
	},
	{
		author: 'jojo',
		rkey: 'seed-open-studio',
		name: 'Open studio',
		description: 'Prints, coffee, and a look at what I am working on.',
		startsAt: at(12, 22),
		endsAt: at(13, 1),
		mode: 'hybrid',
		location: { locality: 'Louisville', region: 'KY', country: 'US' },
		image: { text: 'Open studio', color: '#7d3a6b' }
	},
	{
		author: 'eli',
		rkey: 'seed-birthday',
		name: 'Birthday drinks',
		description: 'Unlisted: only people with the link see this one.',
		startsAt: at(6, 23),
		mode: 'inperson',
		unlisted: true
	}
];

/** RSVPs to personal events, in each person's own repo. */
const PERSONAL_RSVPS = [
	['ben', 'ada', 'seed-picnic', 'going'],
	['cleo', 'ada', 'seed-picnic', 'interested'],
	['jojo', 'ada', 'seed-picnic', 'going'],
	['hana', 'ada', 'seed-picnic', 'going'],
	['ada', 'jojo', 'seed-open-studio', 'interested'],
	['gus', 'jojo', 'seed-open-studio', 'going'],
	['ivo', 'jojo', 'seed-open-studio', 'notgoing'],
	['dara', 'eli', 'seed-birthday', 'going'],
	['fay', 'eli', 'seed-birthday', 'going']
];

// --- logins -------------------------------------------------------------------------

function readEnv(file) {
	const out = {};
	if (!existsSync(file)) return out;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
		if (m) out[m[1]] = m[2];
	}
	return out;
}
const logins = readEnv(LOGINS_FILE);
function saveLogins() {
	const body = Object.keys(logins)
		.sort()
		.map((k) => `${k}=${logins[k]}`)
		.join('\n');
	writeFileSync(LOGINS_FILE, `${body}\n`, { mode: 0o600 });
	chmodSync(LOGINS_FILE, 0o600);
}
const key = (name, field) => `SEED_${name.toUpperCase()}_${field}`;
const handleOf = (name) => `${name}.${DOMAIN}`;
const did = (name) => logins[key(name, 'DID')];
const password = (name) => logins[key(name, 'PASSWORD')];

// --- xrpc ---------------------------------------------------------------------------

async function xrpc(method, { query, body, token, raw, contentType } = {}) {
	const url = new URL(`${PDS}/xrpc/${method}`);
	for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
	const headers = {};
	if (token) headers.authorization = `Bearer ${token}`;
	let payload;
	if (raw) {
		payload = raw;
		headers['content-type'] = contentType;
	} else if (body) {
		payload = JSON.stringify(body);
		headers['content-type'] = 'application/json';
	}
	const res = await fetch(url, { method: payload ? 'POST' : 'GET', headers, body: payload });
	const text = await res.text();
	const json = text ? JSON.parse(text) : {};
	if (!res.ok) {
		const err = new Error(
			`${method}: ${res.status} ${json.error ?? ''} ${json.message ?? ''}`.trim()
		);
		err.status = res.status;
		err.code = json.error;
		throw err;
	}
	return json;
}

const sessions = new Map();
async function session(name) {
	if (!sessions.has(name)) {
		const s = await xrpc('com.atproto.server.createSession', {
			body: { identifier: handleOf(name), password: password(name) }
		});
		sessions.set(name, s.accessJwt);
	}
	return sessions.get(name);
}

async function getRecord(repo, collection, rkey) {
	try {
		return await xrpc('com.atproto.repo.getRecord', { query: { repo, collection, rkey } });
	} catch (e) {
		if (e.status === 400 || e.status === 404) return null;
		throw e;
	}
}

async function putRecord(name, collection, rkey, record) {
	return xrpc('com.atproto.repo.putRecord', {
		token: await session(name),
		body: { repo: did(name), collection, rkey, record }
	});
}

/** Tells atmo about a record now, instead of waiting for its ingest. */
async function notifyAtmo(uri) {
	const res = await fetch(`${ATMO}/xrpc/rsvp.atmo.notifyOfUpdate`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ uri })
	});
	if (!res.ok) log(`  atmo was not told of ${uri}: ${res.status}`);
}

function log(line) {
	console.log(line);
}

// --- pictures -----------------------------------------------------------------------

let browser;
async function chromium() {
	if (!browser) {
		const pw = await import(process.env.SEED_PLAYWRIGHT ?? 'playwright');
		browser = await pw.chromium.launch();
	}
	return browser;
}

/** A plain picture with a word on it, drawn by the browser: no image files to carry. */
async function picture({ text, color }, { width = 1200, height = 630 } = {}) {
	const page = await (await chromium()).newPage({ viewport: { width, height } });
	await page.setContent(
		`<body style="margin:0;display:grid;place-items:center;height:100vh;background:${color};` +
			`font:600 ${Math.round(height / 6)}px system-ui,sans-serif;color:#fff">${text}</body>`
	);
	const png = await page.screenshot({ type: 'png' });
	await page.close();
	return { png, width, height };
}

async function uploadPicture(name, spec, size) {
	const { png, width, height } = await picture(spec, size);
	const out = await xrpc('com.atproto.repo.uploadBlob', {
		token: await session(name),
		raw: png,
		contentType: 'image/png'
	});
	return { blob: out.blob, width, height };
}

// --- steps --------------------------------------------------------------------------

async function people() {
	const invite = readEnv(need('SEED_INVITE_FILE')).SEED_INVITE_CODE;
	for (const p of PEOPLE) {
		const handle = handleOf(p.name);
		let existing = null;
		try {
			existing = await xrpc('com.atproto.identity.resolveHandle', { query: { handle } });
		} catch {
			existing = null;
		}
		if (existing?.did) {
			if (!password(p.name)) {
				throw new Error(`${handle} exists but no login for it is kept; reset its password first`);
			}
			logins[key(p.name, 'DID')] = existing.did;
			log(`  ${handle}: exists (${existing.did})`);
		} else {
			if (!invite) throw new Error('no invite code (SEED_INVITE_CODE)');
			const pw = randomBytes(18).toString('base64url');
			const made = await xrpc('com.atproto.server.createAccount', {
				body: { handle, email: `${p.name}@devnet.test`, password: pw, inviteCode: invite }
			});
			logins[key(p.name, 'HANDLE')] = handle;
			logins[key(p.name, 'DID')] = made.did;
			logins[key(p.name, 'PASSWORD')] = pw;
			saveLogins();
			log(`  ${handle}: made (${made.did})`);
		}
		logins[key(p.name, 'HANDLE')] = handle;
	}
	saveLogins();
}

async function profiles() {
	for (const p of PEOPLE) {
		const have = await getRecord(did(p.name), 'app.bsky.actor.profile', 'self');
		if (have?.value?.displayName === p.displayName && have.value.avatar) {
			log(`  ${p.name}: profile already set`);
			continue;
		}
		const colors = ['#c0392b', '#2471a3', '#1e8449', '#b7950b', '#7d3c98'];
		const avatar = await uploadPicture(
			p.name,
			{ text: p.displayName[0], color: colors[PEOPLE.indexOf(p) % colors.length] },
			{ width: 400, height: 400 }
		);
		await putRecord(p.name, 'app.bsky.actor.profile', 'self', {
			$type: 'app.bsky.actor.profile',
			displayName: p.displayName,
			description: p.description,
			avatar: avatar.blob
		});
		log(`  ${p.name}: profile set`);
	}
}

function eventRecord(e, media) {
	const record = {
		$type: 'community.lexicon.calendar.event',
		createdWith: 'https://atmo.rsvp',
		name: e.name,
		description: e.description,
		mode: `community.lexicon.calendar.event#${e.mode}`,
		status: 'community.lexicon.calendar.event#scheduled',
		startsAt: e.startsAt,
		timezone: 'America/New_York',
		createdAt: new Date().toISOString(),
		preferences: { showInDiscovery: !e.unlisted }
	};
	if (e.endsAt) record.endsAt = e.endsAt;
	if (e.location)
		record.locations = [{ $type: 'community.lexicon.location.address', ...e.location }];
	if (media) record.media = media;
	return record;
}

async function personalEvents() {
	for (const e of PERSONAL_EVENTS) {
		const have = await getRecord(did(e.author), 'community.lexicon.calendar.event', e.rkey);
		if (have) {
			log(`  ${e.name}: already there`);
			continue;
		}
		let media;
		if (e.image) {
			const pic = await uploadPicture(e.author, e.image);
			media = [
				{
					role: 'thumbnail',
					content: pic.blob,
					aspect_ratio: { width: pic.width, height: pic.height }
				}
			];
		}
		const out = await putRecord(
			e.author,
			'community.lexicon.calendar.event',
			e.rkey,
			eventRecord(e, media)
		);
		await notifyAtmo(out.uri);
		log(`  ${e.name}: made by ${e.author}${e.unlisted ? ' (unlisted)' : ''}`);
	}
}

/** One RSVP in `who`'s own repo to a public event; its key is the event's, so one each. */
async function publicRsvp(who, eventUri, status, known) {
	const [, , repo, collection, rkey] = eventUri.split('/');
	// An event in another server's repo (a group's, at the group host) comes in as `known`:
	// the people's account server has no route to read it.
	const event = known ?? (await getRecord(repo, collection, rkey));
	if (!event) throw new Error(`no event at ${eventUri}`);
	const rsvpKey = `seed-${rkey}`.slice(0, 64);
	const have = await getRecord(did(who), 'community.lexicon.calendar.rsvp', rsvpKey);
	if (have?.value?.status === `community.lexicon.calendar.rsvp#${status}`) return false;
	const out = await putRecord(who, 'community.lexicon.calendar.rsvp', rsvpKey, {
		$type: 'community.lexicon.calendar.rsvp',
		subject: { uri: event.uri, cid: event.cid },
		status: `community.lexicon.calendar.rsvp#${status}`,
		createdAt: new Date().toISOString()
	});
	await notifyAtmo(out.uri);
	return true;
}

async function personalRsvps() {
	for (const [who, author, rkey, status] of PERSONAL_RSVPS) {
		const changed = await publicRsvp(
			who,
			`at://${did(author)}/community.lexicon.calendar.event/${rkey}`,
			status
		);
		log(`  ${who} ${status} at ${author}'s ${rkey}${changed ? '' : ' (already)'}`);
	}
}

// --- through atmo's pages -------------------------------------------------------------
//
// A group is made, and anything is done as one, only through atmo in a browser: the group
// host signs people in with OAuth, and atmo's own set-up runs on the session that comes
// back. Each person gets a browser context of their own, signed in to atmo once.

/** The three kinds of group, each run by its organizer. `label` is the group's handle's
 *  first label at the group host. */
const GROUPS = [
	{
		key: 'runners',
		label: 'runners',
		organizer: 'ada',
		name: 'Riverside Runners',
		description: 'Easy runs along the river, every pace welcome. Just turn up.',
		rules: 'Nobody gets left behind\nLights after dark',
		visibility: 'public',
		approval: false,
		color: '#1f618d'
	},
	{
		key: 'books',
		label: 'bookcircle',
		organizer: 'ben',
		name: 'Book Circle',
		description: 'One book a month, one evening to talk about it. Ask to join.',
		rules: 'Finish the book, or say so\nNo spoilers before the meeting',
		visibility: 'public',
		approval: true,
		color: '#935116'
	},
	{
		key: 'board',
		label: 'boardroom',
		organizer: 'cleo',
		name: 'Board Room',
		description: 'The association board. Members are added by the chair.',
		rules: 'Minutes within a week',
		visibility: 'private',
		approval: true,
		color: '#4a235a'
	}
];

const SHOTS = process.env.SEED_SHOTS;
let shotCount = 0;
async function shot(page, what) {
	if (!SHOTS) return;
	shotCount += 1;
	await page
		.screenshot({
			path: `${SHOTS}/${String(shotCount).padStart(2, '0')}-${what}.png`,
			fullPage: true
		})
		.catch(() => {});
}

const where = (page) => {
	const u = new URL(page.url());
	return `${u.host}${u.pathname}`;
};

/** Their own account server's pages: the handle if it asks, the password, then each
 *  consent (the account server's, and the group host's), until `done()` holds. */
async function ownPdsPages(page, name, done) {
	const pdsHost = new URL(PDS).host;
	for (let i = 0; i < 120; i++) {
		if (await done()) return;
		const host = new URL(page.url()).host;
		if (host === pdsHost) {
			const pw = page.locator('input[name=password]');
			if (await pw.isVisible().catch(() => false)) {
				const user = page.locator('input[name=username]');
				if ((await user.count()) && (await user.isEditable()) && !(await user.inputValue())) {
					await user.fill(handleOf(name));
				}
				await pw.fill(password(name));
				await page.getByRole('button', { name: 'Sign in' }).click();
				await page.waitForTimeout(1000);
				continue;
			}
			const accept = page.getByRole('button', { name: /^(accept|authorize|allow)/i }).first();
			if (await accept.isVisible().catch(() => false)) {
				await accept.click();
				await page.waitForTimeout(1000);
				continue;
			}
		}
		if (host === `grouphost.${DOMAIN}`) {
			const handle = page.locator('input[name=handle]');
			if (await handle.isVisible().catch(() => false)) {
				if ((await handle.inputValue()) !== handleOf(name)) await handle.fill(handleOf(name));
				await page.locator('button').first().click();
				await page.waitForTimeout(1000);
				continue;
			}
		}
		if (
			await page
				.locator('#consent')
				.isVisible()
				.catch(() => false)
		) {
			await page.click('#go');
			await page.waitForTimeout(1000);
			continue;
		}
		await page.waitForTimeout(500);
	}
	await shot(page, `stuck-${name}`);
	throw new Error(`${name}'s sign-in did not finish; stuck at ${where(page)}`);
}

const contexts = new Map();
/** A browser signed in to atmo as `name`. */
async function asPerson(name) {
	if (contexts.has(name)) return contexts.get(name);
	const context = await (await chromium()).newContext();
	const page = await context.newPage();
	await page.goto(`${ATMO}/`, { waitUntil: 'networkidle' });
	await page.getByRole('button', { name: 'Login' }).first().click();
	const input = page.locator('input[name=atproto-handle]');
	await input.waitFor({ timeout: 10_000 });
	await input.fill(handleOf(name));
	await input.press('Enter');
	const atmoHost = new URL(ATMO).host;
	await page.waitForURL((u) => u.host !== atmoHost, { timeout: 20_000 });
	await ownPdsPages(page, name, async () => new URL(page.url()).host === atmoHost);
	await page.waitForLoadState('networkidle');
	await page.close();
	contexts.set(name, context);
	log(`  ${name} signed in to atmo`);
	return context;
}

/** The group's DID, if its handle at the group host answers. */
async function groupDid(g) {
	const res = await fetch(`https://${g.label}.gh.${DOMAIN}/.well-known/atproto-did`).catch(
		() => null
	);
	if (!res?.ok) return null;
	const text = (await res.text()).trim();
	return text.startsWith('did:') ? text : null;
}

const groupDids = {};

async function groups() {
	for (const g of GROUPS) {
		const known = await groupDid(g);
		if (known) {
			groupDids[g.key] = known;
			log(`  ${g.name}: exists (${known})`);
			continue;
		}
		const context = await asPerson(g.organizer);
		const page = await context.newPage();
		await page.goto(`${ATMO}/groups/create`, { waitUntil: 'networkidle' });
		await page.fill('#group-name', g.name);
		const avatar = await picture({ text: g.name[0], color: g.color }, { width: 400, height: 400 });
		await page.setInputFiles('#group-avatar', {
			name: 'avatar.png',
			mimeType: 'image/png',
			buffer: avatar.png
		});
		await page.fill('#group-description', g.description);
		await page.fill('#group-rules', g.rules);
		await page.selectOption('#group-visibility', g.visibility);
		if (g.visibility === 'public') {
			await page.locator('input[name=requireApproval]').setChecked(g.approval);
		}
		await shot(page, `create-${g.key}`);
		await page.getByRole('button', { name: 'Create group' }).click();
		const atmoHost = new URL(ATMO).host;
		await page.waitForURL((u) => u.host !== atmoHost, { timeout: 30_000 });
		await page.waitForSelector('input[name=handle]', { timeout: 30_000 });
		await page.fill('input[name=label]', g.label);
		await page.fill('input[name=handle]', handleOf(g.organizer));
		await shot(page, `host-${g.key}`);
		await page.click('button');
		await ownPdsPages(
			page,
			g.organizer,
			async () =>
				new URL(page.url()).host === atmoHost &&
				/^\/groups\/did:/.test(new URL(page.url()).pathname)
		);
		await page.waitForLoadState('networkidle');
		await shot(page, `made-${g.key}`);
		const made = decodeURIComponent(new URL(page.url()).pathname.split('/')[2]);
		groupDids[g.key] = made;
		log(
			`  ${g.name}: made by ${g.organizer} (${made}, ${g.visibility}${g.approval ? ', approval' : ', open'})`
		);
		await page.close();
	}
}

/** Who asks to join what from the group's own page. The open group takes them at once; the
 *  approval group queues them, and its organizer approves all but hana (see APPROVALS). */
const JOINS = [
	['dara', 'runners'],
	['eli', 'runners'],
	['fay', 'runners'],
	['ivo', 'runners'],
	['dara', 'books'],
	['eli', 'books'],
	['hana', 'books']
];

async function groupPage(name, g, path = '') {
	const did = groupDids[g] ?? (await groupDid(GROUPS.find((x) => x.key === g)));
	if (!did) throw new Error(`group ${g} is not made yet`);
	groupDids[g] = did;
	const page = await (await asPerson(name)).newPage();
	await page.goto(`${ATMO}/groups/${did}${path}`, { waitUntil: 'networkidle' });
	return page;
}

async function joins() {
	for (const [who, g] of JOINS) {
		const page = await groupPage(who, g);
		const leave = page.getByRole('button', { name: 'Leave group' });
		const withdraw = page.getByRole('button', { name: 'Withdraw request' });
		if (
			(await leave.isVisible().catch(() => false)) ||
			(await withdraw.isVisible().catch(() => false))
		) {
			log(`  ${who} in ${g}: already ${(await leave.isVisible()) ? 'a member' : 'waiting'}`);
			await page.close();
			continue;
		}
		const button = page.getByRole('button', { name: /^(Join|Request to join)$/ });
		await button.click();
		await page
			.waitForFunction(
				() => /Leave group|Withdraw request|pending|requested/i.test(document.body.innerText),
				null,
				{ timeout: 20_000 }
			)
			.catch(() => {});
		await page.waitForLoadState('networkidle');
		const text = await page.locator('main').innerText();
		const outcome = /Leave group/.test(text)
			? 'joined'
			: /Withdraw request|pending|requested/i.test(text)
				? 'asked'
				: 'unclear';
		if (outcome === 'unclear') await shot(page, `join-${who}-${g}`);
		log(`  ${who} in ${g}: ${outcome}`);
		await page.close();
	}
}

/** A person's atmo sign-in carries a group's grant only once their account server has
 *  learned of the group (up to 10 minutes after it is made); until then the group's page
 *  offers a fresh sign-in. Takes it when offered, and hands back the group's page. */
async function withAccess(name, g, path = '') {
	// The offer is on the group's own page, whatever page is wanted after.
	let page = await groupPage(name, g);
	const again = page.getByRole('button', {
		name: /^(Sign in again|Link your access|Reconnect your access)$/
	});
	if (
		!(await again
			.first()
			.isVisible()
			.catch(() => false))
	) {
		if (path)
			await page.goto(`${ATMO}/groups/${groupDids[g]}${path}`, { waitUntil: 'networkidle' });
		return page;
	}
	await again.first().click();
	const atmoHost = new URL(ATMO).host;
	const left = await page
		.waitForURL((u) => u.host !== atmoHost, { timeout: 15_000 })
		.then(() => true)
		.catch(() => false);
	if (!left) {
		await shot(page, `access-${name}-${g}`);
		const why = await page.locator('main').innerText();
		throw new Error(
			`${name} could not sign in again for ${g}: ${why.match(/Your account's server[^\n]*|Try again[^\n]*/)?.[0] ?? 'no reason shown'}`
		);
	}
	await ownPdsPages(page, name, async () => new URL(page.url()).host === atmoHost);
	await page.close();
	log(`  ${name} signed in again with ${g}'s grant`);
	page = await groupPage(name, g, path);
	return page;
}

/** The organizer approves these; hana's request is left waiting. */
const APPROVALS = [
	['books', 'dara'],
	['books', 'eli']
];
/** The private group's members come in only this way: its organizer adds them. */
const ADDS = [
	['board', 'fay', 'member'],
	['board', 'gus', 'member']
];
/** Role changes after joining. */
const ROLES = [['runners', 'dara', 'admin']];

const organizerOf = (g) => GROUPS.find((x) => x.key === g).organizer;

/** The member rows' state, read from the members page as their organizer sees it. */
async function memberRole(page, who) {
	const form = page.locator(
		`form:has(input[name=did][value="${did(who)}"]):has(select[name=role])`
	);
	if (!(await form.count())) return null;
	return form.locator('select[name=role]').inputValue();
}

async function organize() {
	for (const [g, who] of APPROVALS) {
		const page = await withAccess(organizerOf(g), g, '/members');
		const form = page.locator(`form:has(input[name=member][value="${did(who)}"])`).filter({
			has: page.getByRole('button', { name: 'Approve' })
		});
		if (!(await form.count())) {
			log(
				`  ${g}: no request from ${who} to approve${(await memberRole(page, who)) ? ' (already a member)' : ''}`
			);
			await page.close();
			continue;
		}
		await form.getByRole('button', { name: 'Approve' }).click();
		await form.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {});
		log(`  ${g}: ${organizerOf(g)} approved ${who}`);
		await page.close();
	}
	for (const [g, who, role] of ADDS) {
		const page = await withAccess(organizerOf(g), g, '/members');
		if (await memberRole(page, who)) {
			log(`  ${g}: ${who} already a member`);
			await page.close();
			continue;
		}
		await page.fill('#add-actor', handleOf(who));
		await page.selectOption('#add-role', role);
		await page.getByRole('button', { name: 'Add', exact: true }).click();
		await page
			.locator(`form:has(input[name=did][value="${did(who)}"])`)
			.first()
			.waitFor({ timeout: 20_000 })
			.catch(() => {});
		const now = await memberRole(page, who);
		if (!now) await shot(page, `add-${who}-${g}`);
		log(`  ${g}: ${organizerOf(g)} added ${who}${now ? ` as ${now}` : ' (not shown yet)'}`);
		await page.close();
	}
	for (const [g, who, role] of ROLES) {
		const page = await withAccess(organizerOf(g), g, '/members');
		const was = await memberRole(page, who);
		if (was === role) {
			log(`  ${g}: ${who} already ${role}`);
			await page.close();
			continue;
		}
		if (!was) throw new Error(`${who} is not a member of ${g} to give a role`);
		const form = page.locator(
			`form:has(input[name=did][value="${did(who)}"]):has(select[name=role])`
		);
		await form.locator('select[name=role]').selectOption(role);
		await form.getByRole('button', { name: 'Set role' }).click();
		await page.waitForLoadState('networkidle');
		await page.waitForTimeout(1500);
		await page.reload({ waitUntil: 'networkidle' });
		log(`  ${g}: ${who} ${was} -> ${(await memberRole(page, who)) ?? 'unknown'}`);
		await page.close();
	}
}

/** Group events, made in atmo's editor by someone holding the group's create permission
 *  (the organizer, or dara as the runners' co-admin). `members` puts one in the group's
 *  calendar space, where only members read it. */
const GROUP_EVENTS = [
	{
		group: 'runners',
		by: 'ada',
		placement: 'everyone',
		name: 'Saturday long run',
		description: '10 miles at conversation pace. Meet at the boathouse.',
		days: 6,
		hour: 8,
		mode: 'inperson',
		image: { text: 'Long run', color: '#1f618d' }
	},
	{
		group: 'runners',
		by: 'ada',
		placement: 'members',
		name: "Members' trail day",
		description: 'Carpool to the state forest. Members only, details inside.',
		days: 13,
		hour: 9,
		mode: 'inperson'
	},
	{
		group: 'runners',
		by: 'ada',
		placement: 'everyone',
		name: 'Summer 10K',
		description: 'Our summer race, for the record.',
		days: -20,
		hour: 8,
		mode: 'inperson',
		image: { text: '10K', color: '#117864' }
	},
	{
		group: 'runners',
		by: 'dara',
		placement: 'everyone',
		name: 'Hill repeats',
		description: 'Six times up Cherokee Hill. Dara leads.',
		days: 4,
		hour: 18,
		mode: 'inperson'
	},
	{
		group: 'books',
		by: 'ben',
		placement: 'everyone',
		name: 'October book night',
		description: 'This month: a short novel, a long argument. Everyone welcome.',
		days: 10,
		hour: 19,
		mode: 'hybrid',
		image: { text: 'Book night', color: '#935116' }
	},
	{
		group: 'books',
		by: 'ben',
		placement: 'members',
		name: 'Reading list vote',
		description: "Pick next quarter's books.",
		days: 17,
		hour: 19,
		mode: 'virtual'
	},
	{
		group: 'board',
		by: 'cleo',
		placement: 'members',
		name: 'Quarterly planning',
		description: 'Agenda in the group. Members of the board only.',
		days: 8,
		hour: 18,
		mode: 'inperson'
	},
	{
		group: 'board',
		by: 'cleo',
		placement: 'members',
		name: 'Budget review',
		description: "Next year's budget, line by line.",
		days: 22,
		hour: 18,
		mode: 'virtual'
	}
];

/** Local date and 12-hour clock parts, `days` from now at `hour` o'clock. */
function when(days, hour) {
	const d = new Date(Date.now() + days * DAY);
	d.setHours(hour, 0, 0, 0);
	const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
	return { d, date, hour12: String(hour % 12 || 12), period: hour < 12 ? 'A' : 'P' };
}

/** Sets the editor's `n`th date-and-time picker (0 start, 1 end). */
async function setPicker(page, n, { d, date, hour12, period }) {
	await page.locator('[data-segment=trigger]').nth(n).click();
	await page.locator('select[data-calendar-year-select]').selectOption(String(d.getFullYear()));
	await page.locator('select[data-calendar-month-select]').selectOption(String(d.getMonth() + 1));
	await page.locator(`[data-bits-day][data-value="${date}"]:not([data-outside-month])`).click();
	await page.waitForTimeout(300);
	// Clicking the day already chosen leaves the calendar open.
	if (
		await page
			.locator('select[data-calendar-year-select]')
			.isVisible()
			.catch(() => false)
	) {
		await page.keyboard.press('Escape');
		await page.waitForTimeout(300);
	}
	// Picking the day opens the time's list of half-hour slots; a slot is clicked, as a
	// person would (typing into the hour and minute fields mangles the end time).
	const slot = `${hour12}:00 ${period}M`;
	const seg = page.locator('[data-segment=hour]').nth(n);
	const backdrop = page.locator('div.fixed.inset-0.z-40');
	if (!(await backdrop.isVisible().catch(() => false))) await seg.focus();
	// The end's slots also carry the length ("10:00 AM2h"), so a slot is matched by its start.
	const pick = page
		.locator('button')
		.filter({ hasText: new RegExp(`^${slot}`), visible: true })
		.first();
	if (!(await pick.count())) {
		const offered = await page.locator('button, [role=option], li').evaluateAll((es) =>
			es
				.map((e) => e.textContent.trim())
				.filter((t) => /\d:\d\d/.test(t))
				.slice(0, 12)
		);
		throw new Error(`no ${slot} slot in picker ${n}; offered: ${offered.join(' | ')}`);
	}
	await pick.click();
	await page.waitForTimeout(300);
	if (await backdrop.isVisible().catch(() => false))
		await backdrop.click({ position: { x: 5, y: 5 } });
}

async function groupEventNames(name, g) {
	const page = await withAccess(name, g, '/events');
	const text = await page.locator('main').innerText();
	await page.close();
	return text;
}

async function fillEvent(page, e) {
	await page.locator(`#placement-${e.placement}`).check();
	await page.locator('div[contenteditable=true]:not([data-segment])').first().click();
	await page.keyboard.type(e.name);
	await page.locator(`button[data-value=${e.mode}]`).click();
	await setPicker(page, 0, when(e.days, e.hour));
	await setPicker(page, 1, when(e.days, e.hour + 2));
	await page.locator('textarea').first().fill(e.description);
	if (e.image) {
		const pic = await picture(e.image);
		await page.setInputFiles('input[type=file]', {
			name: 'cover.png',
			mimeType: 'image/png',
			buffer: pic.png
		});
		await page.waitForTimeout(500);
	}
}

async function groupEvents() {
	for (const e of GROUP_EVENTS) {
		if ((await groupEventNames(e.by, e.group)).includes(e.name)) {
			log(`  ${e.group}: ${e.name} already there`);
			continue;
		}
		const page = await withAccess(e.by, e.group, '/events/new');
		try {
			await fillEvent(page, e);
		} catch (err) {
			await shot(page, `event-stuck-${e.group}-${e.days}`);
			throw err;
		}
		await shot(page, `event-${e.group}-${e.days}`);
		const before = page.url();
		await page.getByRole('button', { name: 'Publish Event' }).click();
		const left = await page
			.waitForURL((u) => u.href !== before && !u.pathname.endsWith('/new'), { timeout: 30_000 })
			.then(() => true)
			.catch(() => false);
		if (!left) {
			await shot(page, `event-failed-${e.group}-${e.days}`);
			const err = await page
				.locator('.text-red-600')
				.allInnerTexts()
				.catch(() => []);
			throw new Error(`${e.name} did not publish: ${err.join(' ') || 'no message'}`);
		}
		log(`  ${e.group}: ${e.by} made ${e.name} (${e.placement}) at ${new URL(page.url()).pathname}`);
		await page.close();
	}
}

/** RSVPs to group events: [who, group, event name, status]. atmo's buttons offer going and
 *  interested; a not-going, or any answer to a past event, is written to the person's own
 *  repo instead, which only a public event takes. */
const GROUP_RSVPS = [
	['dara', 'runners', 'Saturday long run', 'going'],
	['eli', 'runners', 'Saturday long run', 'going'],
	['fay', 'runners', 'Saturday long run', 'interested'],
	['jojo', 'runners', 'Saturday long run', 'interested'],
	['ivo', 'runners', 'Saturday long run', 'notgoing'],
	['eli', 'runners', 'Summer 10K', 'going'],
	['ivo', 'runners', 'Summer 10K', 'going'],
	['eli', 'runners', 'Hill repeats', 'interested'],
	['fay', 'runners', 'Hill repeats', 'going'],
	['dara', 'runners', "Members' trail day", 'going'],
	['eli', 'runners', "Members' trail day", 'going'],
	['fay', 'runners', "Members' trail day", 'interested'],
	['eli', 'books', 'October book night', 'going'],
	['dara', 'books', 'October book night', 'interested'],
	['hana', 'books', 'October book night', 'interested'],
	['jojo', 'books', 'October book night', 'going'],
	['eli', 'books', 'Reading list vote', 'going'],
	['dara', 'books', 'Reading list vote', 'interested'],
	['fay', 'board', 'Quarterly planning', 'going'],
	['gus', 'board', 'Quarterly planning', 'going'],
	['gus', 'board', 'Budget review', 'interested']
];

/** A group's public events, read from its own repo at the group host. */
const publicEventsCache = {};
async function publicGroupEvents(g) {
	if (publicEventsCache[g]) return publicEventsCache[g];
	const gd = groupDids[g] ?? (await groupDid(GROUPS.find((x) => x.key === g)));
	const doc = await (await fetch(`https://plc.${DOMAIN}/${gd}`)).json();
	const pds = doc.service.find((x) => x.id.endsWith('#atproto_pds')).serviceEndpoint;
	const res = await fetch(
		`${pds}/xrpc/com.atproto.repo.listRecords?repo=${gd}&collection=community.lexicon.calendar.event&limit=100`
	);
	const out = res.ok ? (await res.json()).records : [];
	publicEventsCache[g] = out;
	return out;
}

/** What the page says once an RSVP is in: a banner, or for going a share dialog first. */
const STATUS_SHOWN = { going: /^You're going/i, interested: /^You're interested/i };

async function groupRsvps() {
	for (const [who, g, name, status] of GROUP_RSVPS) {
		const spec = GROUP_EVENTS.find((e) => e.group === g && e.name === name);
		if (status === 'notgoing' || spec.days < 0) {
			const ev = (await publicGroupEvents(g)).find((r) => r.value.name === name);
			if (!ev) throw new Error(`${name} is not in ${g}'s public repo`);
			const changed = await publicRsvp(who, ev.uri, status, ev);
			log(`  ${who} ${status} at ${name}${changed ? '' : ' (already)'}`);
			continue;
		}
		const list = await withAccess(who, g, '/events');
		const link = list.getByRole('link', { name }).first();
		if (!(await link.count())) {
			await shot(list, `rsvp-nolink-${who}`);
			throw new Error(`${who} sees no ${name} on ${g}'s events page`);
		}
		const href = await link.getAttribute('href');
		await list.close();
		const page = await (await asPerson(who)).newPage();
		await page.goto(new URL(href, ATMO).href, { waitUntil: 'networkidle' });
		if (
			await page
				.getByText(STATUS_SHOWN[status])
				.first()
				.isVisible()
				.catch(() => false)
		) {
			log(`  ${who} ${status} at ${name} (already)`);
			await page.close();
			continue;
		}
		const label = status === 'going' ? 'Going' : 'Interested';
		await page.getByRole('button', { name: label, exact: true }).first().click();
		const atmoHost = new URL(ATMO).host;
		// A members-only RSVP may first ask the person's account server for the group grant.
		const outcome = await Promise.race([
			page
				.getByText(STATUS_SHOWN[status])
				.first()
				.waitFor({ timeout: 20_000 })
				.then(() => 'shown'),
			page.waitForURL((u) => u.host !== atmoHost, { timeout: 20_000 }).then(() => 'left')
		]).catch(() => 'nothing');
		if (outcome === 'left') {
			await ownPdsPages(page, who, async () => new URL(page.url()).host === atmoHost);
			await page.waitForLoadState('networkidle');
			if (
				!(await page
					.getByText(STATUS_SHOWN[status])
					.first()
					.isVisible()
					.catch(() => false))
			) {
				await page.getByRole('button', { name: label, exact: true }).first().click();
				await page
					.getByText(STATUS_SHOWN[status])
					.first()
					.waitFor({ timeout: 20_000 })
					.catch(() => {});
			}
		}
		const ok = await page
			.getByText(STATUS_SHOWN[status])
			.first()
			.isVisible()
			.catch(() => false);
		if (!ok) await shot(page, `rsvp-${who}-${name.replace(/\W+/g, '-')}`);
		log(`  ${who} ${status} at ${name}${ok ? '' : ' (NOT shown afterwards)'}`);
		await page.close();
	}
}

const STEPS = {
	people,
	profiles,
	personalEvents,
	personalRsvps,
	groups,
	joins,
	organize,
	groupEvents,
	groupRsvps
};

let failed = false;
try {
	for (const [name, step] of Object.entries(STEPS)) {
		if (ONLY.length && !ONLY.includes(name)) continue;
		log(`${name}:`);
		await step();
	}
} catch (e) {
	failed = true;
	log(`FAILED: ${e instanceof Error ? e.message : String(e)}`);
} finally {
	saveLogins();
	await browser?.close();
}
process.exit(failed ? 1 : 0);

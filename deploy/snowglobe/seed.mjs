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
async function publicRsvp(who, eventUri, status) {
	const [, , repo, collection, rkey] = eventUri.split('/');
	const event = await getRecord(repo, collection, rkey);
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

const STEPS = { people, profiles, personalEvents, personalRsvps };

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

// atmo on a snowglobe, through its network settings: `pnpm globe:e2e` from the repo root.
//
// Starts atmo's dev server with the settings `snowglobe run` hands this script, writes an event as
// alice straight to her PDS, runs atmo's cron until contrail has taken it from the snowglobe's
// Jetstream, and reads it back from atmo's event page by alice's handle.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

function required(name) {
	const value = process.env[name]?.trim();
	if (!value) {
		console.error(`${name} is not set. Run this with pnpm globe:e2e.`);
		process.exit(2);
	}
	return value;
}

const PDS = required('E2E_PDS');
const HANDLE = required('E2E_HANDLE');
const PASSWORD = required('E2E_PASSWORD');
const PLC = required('PUBLIC_PLC_URL');
const PORT = Number(process.env.E2E_PORT || 5455);
const ATMO = `http://127.0.0.1:${PORT}`;
const CRON_SECRET = randomBytes(16).toString('hex');
const EVENT = 'community.lexicon.calendar.event';

let failures = 0;
function check(ok, label, detail) {
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? `: ${detail}` : ''}`);
	if (!ok) failures++;
	return ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function startAtmo() {
	const child = spawn('pnpm', ['--filter', 'web', 'dev', '--port', String(PORT), '--strictPort'], {
		env: { ...process.env, CRON_SECRET },
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true
	});
	let log = '';
	child.stdout.on('data', (chunk) => (log += chunk));
	child.stderr.on('data', (chunk) => (log += chunk));
	return {
		stop: () => {
			try {
				process.kill(-child.pid, 'SIGTERM');
			} catch {
				// already gone
			}
		},
		log: () => log
	};
}

async function waitForAtmo(atmo) {
	for (let i = 0; i < 90; i++) {
		try {
			if ((await fetch(ATMO)).status < 500) return true;
		} catch {
			// not listening yet
		}
		await sleep(1000);
	}
	console.error(atmo.log().slice(-3000));
	return false;
}

async function pds(method, nsid, body, token) {
	const response = await fetch(`${PDS}/xrpc/${nsid}`, {
		method,
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: body && JSON.stringify(body)
	});
	if (!response.ok) throw new Error(`${nsid}: ${response.status} ${await response.text()}`);
	return response.json();
}

function cron() {
	return fetch(`${ATMO}/api/cron`, { method: 'POST', headers: { 'X-Cron-Secret': CRON_SECRET } });
}

const atmo = startAtmo();
let session;
let rkey;

async function run() {
	if (!check(await waitForAtmo(atmo), `atmo's dev server answers at ${ATMO}`)) return;

	const home = await (await fetch(ATMO)).text();
	check(home.includes(PLC), "the page carries the snowglobe's PLC address for the browser");

	// The first run sets contrail's Jetstream cursor, so the event below comes after it.
	const first = await cron();
	if (!check(first.ok, 'the cron runs', `${first.status}`)) return;

	session = await pds('POST', 'com.atproto.server.createSession', {
		identifier: HANDLE,
		password: PASSWORD
	});
	const name = `Network settings check ${Date.now().toString(36)}`;
	const created = await pds(
		'POST',
		'com.atproto.repo.createRecord',
		{
			repo: session.did,
			collection: EVENT,
			record: {
				$type: EVENT,
				name,
				createdAt: new Date().toISOString(),
				startsAt: new Date(Date.now() + 86_400_000).toISOString()
			}
		},
		session.accessJwt
	);
	rkey = created.uri.split('/').pop();

	let page;
	let status;
	for (let i = 0; i < 6 && !page?.includes(name); i++) {
		await cron();
		const response = await fetch(`${ATMO}/p/${HANDLE}/e/${rkey}`);
		status = response.status;
		page = response.ok ? await response.text() : undefined;
	}
	const shown = check(
		Boolean(page?.includes(name)),
		"atmo shows an event it took from the snowglobe's Jetstream, found by alice's handle",
		`the event page answered ${status}`
	);
	if (!shown) console.error(atmo.log().slice(-4000));
}

try {
	await run();
} catch (error) {
	check(false, 'the run finished', String(error));
} finally {
	if (session && rkey) {
		await pds(
			'POST',
			'com.atproto.repo.deleteRecord',
			{ repo: session.did, collection: EVENT, rkey },
			session.accessJwt
		).catch(() => {});
	}
	atmo.stop();
}

console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);

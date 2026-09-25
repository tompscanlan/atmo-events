#!/usr/bin/env node
/**
 * End-to-end proof of the Spaces half of the openmeet-atmo API against the
 * live Spaces PDS fixture (https://pds.opnmt.net).
 *
 *   node apps/api/scripts/spaces-e2e.mjs
 *
 * What it proves, in order:
 *   1. the group (custodian of its own DID) can put a record into its Space —
 *      the only legal write path, since Space writes require repo === the
 *      authenticated DID;
 *   2. a member's one-time delegation token is exchanged by the Worker for a
 *      DPoP-bound Space credential (`authorizeSpace`);
 *   3. the Worker syncs the Space and projects its records into the isolated
 *      tables, and the member can read them back;
 *   4. a non-member with a perfectly valid service-auth token is refused; and
 *   5. an anonymous caller is refused.
 *
 * It boots `wrangler dev` on a scratch persistence directory, so a non-zero
 * record count is projection work this run actually did.
 *
 * Credentials are read from $HOME/.spaces-alpha-creds.env (the location
 * infra/spaces-alpha/seed.sh writes), falling back to the legacy path. They are
 * never printed. A 401 from createSession means the fixture passwords are
 * stale: re-run `infra/spaces-alpha/seed.sh --apply --reset-passwords`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import {
	SpacesProviderClient,
	formatSpaceUri,
	getServiceAuthToken
} from '@atmo-dev/contrail-spaces-alpha/consumer';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PDS = process.env.SPACES_E2E_PDS ?? 'https://pds.opnmt.net';
const AUTHORITY_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// The group's events space. The alpha has no space of this type until group
// create provisions one; the old `net.openmeet.group`/`kona` fixture predates
// the split of space types from the XRPC prefix, and this worker no longer
// accepts that type.
const SPACE_TYPE = 'net.openmeet.space.events';
const SPACE_SKEY = 'self';
const SPACE_URI = formatSpaceUri({
	authorityDid: AUTHORITY_DID,
	type: SPACE_TYPE,
	skey: SPACE_SKEY
});
const EVENT_COLLECTION = 'community.lexicon.calendar.event';
const EVENT_RKEY = 'openmeet-atmo-e2e';
const EVENT_NAME = 'Kona members-only paddle';

const MEMBER_HANDLE = 'spike-alice.opnmt.net';
const NON_MEMBER_HANDLE = 'spike-mallory.opnmt.net';
const GROUP_HANDLE = 'spike-group.opnmt.net';

/**
 * The Worker is addressed in-process, so this host is a label on the request,
 * not a socket anyone listens on. It must still parse as a URL.
 */
const ORIGIN = 'http://openmeet-atmo-api.invalid';
/** Must match wrangler.jsonc, since the built bundle is what Miniflare runs. */
const COMPATIBILITY_DATE = '2025-12-25';
const QUEUE_NAME = 'openmeet-atmo-spaces';
/** Discovery identity the Worker advertises; service-auth audiences follow it. */
const SERVICE_ENDPOINT = process.env.SPACES_E2E_ENDPOINT ?? 'https://api.openmeet.test';
const AUDIENCE = `did:web:${new URL(SERVICE_ENDPOINT).hostname}#spaces`;
/** The Worker's XRPC namespace, deliberately not the Space type (see SPACES_NAMESPACE). */
const NAMESPACE = 'net.openmeet.group';

const CREDENTIAL_PATHS = [
	join(homedir(), '.spaces-alpha-creds.env'),
	'/workspaces/scratch/spaces-alpha-pds/spike-creds.env'
];

const results = [];

function record(ok, label, detail) {
	results.push({ ok, label, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

async function loadCredentials() {
	for (const path of CREDENTIAL_PATHS) {
		let text;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			continue;
		}
		const passwords = {};
		for (const line of text.split('\n')) {
			const match = /^SPIKE_(\w+)_PASSWORD=['"]?([^'"\s]+)['"]?$/.exec(line.trim());
			if (match) passwords[match[1].toLowerCase()] = match[2];
		}
		if (Object.keys(passwords).length > 0) return { path, passwords };
	}
	throw new Error(
		`no fixture credentials found in ${CREDENTIAL_PATHS.join(' or ')}; run infra/spaces-alpha/seed.sh --apply --reset-passwords`
	);
}

/** Minimal AuthenticatedPdsSession over an app-password session. */
async function pdsSession(handle, password) {
	const response = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: handle, password })
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const hint =
			response.status === 401
				? ' (stale fixture credentials: re-run seed.sh --apply --reset-passwords)'
				: '';
		throw new Error(`createSession ${handle} failed: ${response.status} ${body.error}${hint}`);
	}
	return {
		did: body.did,
		handle(pathname, init = {}) {
			return fetch(`${PDS}${pathname}`, {
				...init,
				headers: { ...(init.headers ?? {}), authorization: `Bearer ${body.accessJwt}` }
			});
		}
	};
}

function providerClient(session) {
	return new SpacesProviderClient({
		endpoint: ORIGIN,
		audience: AUDIENCE,
		namespace: NAMESPACE,
		session,
		// Every worker-bound request goes through Miniflare's in-process
		// dispatch, never a socket. See startWorker for why.
		fetch: workerFetch
	});
}

/** Set by startWorker; closed over by workerFetch and rawListSpaceRecords. */
let miniflare;

/**
 * `fetch` against the Worker under test.
 *
 * `dispatchFetch` takes the URL only to populate `request.url`; ORIGIN is a
 * placeholder host that never resolves and is never connected to.
 */
function workerFetch(url, init) {
	if (!miniflare) throw new Error('worker not started');
	return miniflare.dispatchFetch(String(url), init);
}

/**
 * Boot the Worker in-process on workerd via Miniflare.
 *
 * NOT `wrangler dev`: in this dev container wrangler's dev server accepts the
 * TCP connection and then never answers — measured against the unmodified
 * upstream apps/api too, so it is the environment, not this Worker. Miniflare
 * drives the same workerd runtime and the same D1/Queue emulation without the
 * dev-server and proxy layer in front, and `dispatchFetch` needs no port.
 *
 * The bundle is built first by wrangler (`--dry-run --outdir`), so what runs
 * here is the same artifact a deploy would upload.
 */
async function startWorker(stateDir) {
	const started = Date.now();
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
	const outDir = join(stateDir, 'bundle');
	await build(outDir);
	miniflare = new Miniflare({
		modules: true,
		modulesRoot: outDir,
		// wrangler names the bundle after the config `main`, i.e. src/dispatcher.ts.
		scriptPath: join(outDir, 'dispatcher.js'),
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ['nodejs_compat'],
		d1Databases: { DB: 'openmeet-atmo-api-e2e' },
		queueProducers: { SPACES_QUEUE: QUEUE_NAME },
		queueConsumers: { [QUEUE_NAME]: { maxBatchSize: 10, maxBatchTimeout: 1, maxRetries: 3 } },
		bindings: {
			PUBLIC_SERVICE_ENDPOINT: SERVICE_ENDPOINT,
			SPACES_CREDENTIAL_ENCRYPTION_KEY: key
		},
		defaultPersistRoot: stateDir
	});
	// Force the runtime up now so a startup failure is reported here rather
	// than as a confusing first-request error.
	await miniflare.ready;
	const stop = () => {
		const closing = miniflare?.dispose();
		miniflare = undefined;
		return closing;
	};
	return { stop, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

/** Build the deployable bundle with wrangler, so the e2e runs real output. */
function build(outDir) {
	return new Promise((resolve, reject) => {
		const child = spawn('npx', ['wrangler', 'deploy', '--dry-run', '--outdir', outDir], {
			cwd: API_DIR,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const log = [];
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			stream.on('data', (chunk) => log.push(chunk));
		}
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`wrangler build exited ${code}\n${log.join('')}`));
		});
	});
}

/**
 * Space write as the group itself: repo === the authenticated DID, which is
 * the only legal way to put a record into this Space.
 *
 * The record key is left to the PDS. The alpha PDS accepts a caller-chosen
 * rkey and echoes it back, but the repo commit keeps a TID, so a chosen key
 * never reaches the synced repo; `deleteSeededRecord` cleans up by the key the
 * PDS actually assigned.
 */
async function seedGroupRecord(group) {
	const response = await group.handle('/xrpc/com.atproto.space.createRecord', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space: SPACE_URI,
			repo: group.did,
			collection: EVENT_COLLECTION,
			validate: false,
			record: {
				$type: EVENT_COLLECTION,
				name: EVENT_NAME,
				description: 'Members-only event written by the openmeet-atmo Spaces e2e.',
				createdAt: new Date().toISOString(),
				startsAt: '2026-09-20T17:00:00.000Z',
				endsAt: '2026-09-20T19:00:00.000Z',
				mode: 'community.lexicon.calendar.event#inperson',
				status: 'community.lexicon.calendar.event#scheduled'
			}
		})
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`space createRecord failed: ${response.status} ${body.error}`);
	return { uri: body.uri, cid: body.cid, rkey: String(body.uri).split('/').at(-1) };
}

/** Leave the shared fixture as we found it. */
async function deleteSeededRecord(group, rkey) {
	const response = await group.handle('/xrpc/com.atproto.space.deleteRecord', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			space: SPACE_URI,
			repo: group.did,
			collection: EVENT_COLLECTION,
			rkey
		})
	});
	if (!response.ok) {
		console.log(`WARN  could not delete seeded record ${rkey}: ${response.status}`);
	}
}

async function pollProjection(client, timeoutMs) {
	const started = Date.now();
	let lastError;
	while (Date.now() - started < timeoutMs) {
		try {
			const page = await client.listSpaceRecords({
				space: SPACE_URI,
				collection: EVENT_COLLECTION,
				limit: 50
			});
			if (page.records.length > 0) {
				return { page, seconds: ((Date.now() - started) / 1000).toFixed(1) };
			}
		} catch (error) {
			lastError = error;
		}
		await new Promise((wake) => setTimeout(wake, 1_500));
	}
	throw new Error(
		`no records projected within ${timeoutMs / 1000}s${lastError ? `; last error: ${lastError.message}` : ''}`
	);
}

async function rawListSpaceRecords(authorization) {
	const url = new URL(`/xrpc/${NAMESPACE}.event.listSpaceRecords`, ORIGIN);
	url.searchParams.set('space', SPACE_URI);
	const response = await workerFetch(url, {
		headers: { accept: 'application/json', ...(authorization ? { authorization } : {}) }
	});
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

async function main() {
	console.log('openmeet-atmo Spaces e2e');
	console.log(`  pds     ${PDS}`);
	console.log(`  space   ${SPACE_URI}`);
	console.log(`  worker  ${ORIGIN} (audience ${AUDIENCE})`);
	console.log('');

	const { path, passwords } = await loadCredentials();
	record(true, 'fixture credentials loaded', path);

	const stateDir = await mkdtemp(join(tmpdir(), 'openmeet-atmo-e2e-'));
	let worker;
	let seededRecord;
	let groupSession;
	try {
		worker = await startWorker(stateDir);
		record(true, 'worker ready', `${worker.seconds}s in-process (workerd), empty D1 at ${stateDir}`);

		const [member, nonMember, group] = await Promise.all([
			pdsSession(MEMBER_HANDLE, passwords.alice),
			pdsSession(NON_MEMBER_HANDLE, passwords.mallory),
			pdsSession(GROUP_HANDLE, passwords.group)
		]);
		record(
			true,
			'fixture sessions',
			`member ${member.did}, non-member ${nonMember.did}, group ${group.did}`
		);

		seededRecord = await seedGroupRecord(group);
		groupSession = group;
		record(
			true,
			'group wrote a Space record as custodian',
			`${seededRecord.uri.split('/').slice(-2).join('/')} (cid ${seededRecord.cid})`
		);

		const memberClient = providerClient(member);
		const authorized = await memberClient.authorizeSpace(SPACE_URI);
		record(
			authorized.space === SPACE_URI && authorized.generation >= 1,
			'delegation exchanged for a DPoP-bound Space credential',
			`generation ${authorized.generation}, lease until ${authorized.accessExpiresAt}`
		);

		const { page, seconds } = await pollProjection(memberClient, 120_000);
		record(
			page.records.length > 0,
			'space synced and records projected',
			`${page.records.length} record(s) in ${seconds}s`
		);
		const seededRow = page.records.find((entry) => entry.uri === seededRecord.uri);
		record(
			Boolean(seededRow),
			'member read allowed',
			seededRow
				? `${member.did} read ${page.records.length} record(s) including the new "${seededRow.value.name}"`
				: `${member.did} read ${page.records.length} record(s), not including ${seededRecord.uri}: ${page.records.map((entry) => entry.uri).join(', ')}`
		);

		const nonMemberToken = await getServiceAuthToken(nonMember, {
			audience: AUDIENCE,
			method: `${NAMESPACE}.event.listSpaceRecords`
		});
		const refused = await rawListSpaceRecords(`Bearer ${nonMemberToken}`);
		record(
			refused.status === 403,
			'non-member read refused',
			`${nonMember.did} got ${refused.status} ${refused.body.error ?? ''}`.trim()
		);

		const anonymous = await rawListSpaceRecords(undefined);
		record(
			anonymous.status === 401,
			'anonymous read refused',
			`${anonymous.status} ${anonymous.body.error ?? ''}`.trim()
		);
	} finally {
		if (seededRecord && groupSession) await deleteSeededRecord(groupSession, seededRecord.rkey);
		await worker?.stop();
		await rm(stateDir, { recursive: true, force: true });
	}
}

let failure;
try {
	await main();
} catch (error) {
	failure = error;
	record(false, 'e2e aborted', error.message);
}

const passed = results.filter((entry) => entry.ok).length;
const failed = results.length - passed;
console.log('');
console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0 && failure?.stack) console.error(failure.stack);
process.exit(failed > 0 ? 1 : 0);

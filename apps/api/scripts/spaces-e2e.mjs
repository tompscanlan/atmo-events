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
import {
	SpacesProviderClient,
	formatSpaceUri,
	getServiceAuthToken
} from '@atmo-dev/contrail-spaces-alpha/consumer';

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PDS = process.env.SPACES_E2E_PDS ?? 'https://pds.opnmt.net';
const AUTHORITY_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const SPACE_TYPE = 'net.openmeet.group';
const SPACE_SKEY = 'kona';
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

const PORT = Number(process.env.SPACES_E2E_PORT ?? 8788);
const ORIGIN = `http://127.0.0.1:${PORT}`;
/** Discovery identity the Worker advertises; service-auth audiences follow it. */
const SERVICE_ENDPOINT = process.env.SPACES_E2E_ENDPOINT ?? 'https://api.openmeet.test';
const AUDIENCE = `did:web:${new URL(SERVICE_ENDPOINT).hostname}#spaces`;
const NAMESPACE = SPACE_TYPE;

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
		session
	});
}

async function startWorker(stateDir) {
	const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
	const child = spawn(
		'npx',
		[
			'wrangler',
			'dev',
			'--port',
			String(PORT),
			'--persist-to',
			stateDir,
			'--var',
			`SPACES_CREDENTIAL_ENCRYPTION_KEY:${key}`,
			'--var',
			`PUBLIC_SERVICE_ENDPOINT:${SERVICE_ENDPOINT}`
		],
		{ cwd: API_DIR, stdio: ['ignore', 'pipe', 'pipe'], detached: true }
	);
	const log = [];
	for (const stream of [child.stdout, child.stderr]) {
		stream.setEncoding('utf8');
		stream.on('data', (chunk) => log.push(chunk));
	}
	const stop = () => {
		try {
			process.kill(-child.pid, 'SIGTERM');
		} catch {
			/* already gone */
		}
	};
	const started = Date.now();
	const deadline = started + 120_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) {
			throw new Error(`wrangler dev exited early (${child.exitCode})\n${log.join('')}`);
		}
		try {
			const response = await fetch(`${ORIGIN}/status`);
			if (response.ok) {
				return { stop, log, seconds: ((Date.now() - started) / 1000).toFixed(1) };
			}
			// A 500 here is a Worker startup error, not a race; surface it.
			if (response.status >= 500) {
				throw new Error(`worker /status returned ${response.status}: ${await response.text()}`);
			}
		} catch (error) {
			if (!/fetch failed|ECONNREFUSED/.test(String(error.message))) throw error;
		}
		await new Promise((wake) => setTimeout(wake, 500));
	}
	stop();
	throw new Error(`worker did not become ready\n${log.join('')}`);
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
	const response = await fetch(url, {
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
		record(true, 'worker ready', `${worker.seconds}s on ${ORIGIN}, empty D1 at ${stateDir}`);

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
		worker?.stop();
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

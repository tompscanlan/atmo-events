#!/usr/bin/env node
/**
 * End-to-end test of groups against a live PDS that supports Spaces.
 *
 *   node apps/web/scripts/groups-e2e.mjs
 *
 * It runs 52 numbered checks (1, 4 to 6, 9 to 24, plus 10b, 13b to 13v, 15b,
 * 18b, 18c, 18d, 18e and 20b to 20f), prints one PASS or FAIL line each, and a
 * clean run ends with `SUMMARY: 52 passed, 0 failed`. Setup steps print as notes
 * and are not counted. In order: the app's own create, which mints a new group
 * account for the run, with its seeded roles and member lists (1), events
 * written as the group DID and the edit gate (4-6), a cover image uploaded into
 * the group's repo (9), the profile,
 * rules and access record in the about space (10-12), the roster, the index of
 * the group's three spaces and the authz config as records in the members
 * space, with the calendar space's read policy, access record and member list
 * (13-18), the members-only slice the events tab reads from the calendar
 * space for a member, a non-member, an anonymous visitor and an unlinked group
 * (13d-13h), members-only events written by the app: into the calendar space and
 * nowhere else, edited and deleted there, never moved to or from the public
 * repo, refused for a group without the space, with no field saying who may
 * read them, and with an image kept in the space (13i-13p), that event in a
 * member's slice without its image while the stored record keeps it (13q), the
 * same event read by its key as its page reads it, whole for a member and not
 * at all for a non-member or an anonymous visitor (13r), the same event as its
 * edit page reads it for a manager, whole and with no key naming the space,
 * saved back into the space with its image and no field added, and refused
 * before any read for a member who may not edit and a non-member (13s), a
 * member's RSVP to that seed written from their own session into the calendar
 * space at the event's key, read back by them and by the group, and cancelled
 * (13t), no RSVP request from a non-member or from a member whose PDS serves no
 * spaces, who is sent to re-authorize and told only after asking that their PDS
 * can't do it (13u), that RSVP naming the seed's current cid as the group reads
 * it, and one from a page that showed another version writing nothing (13v),
 * a join request that writes nothing and is refused a members space
 * credential until approved, then confirmed at sign-in, the member's own
 * acceptance deleted at leave, and written at a sign-in after a direct add
 * (18b-18d), a member whose PDS serves no spaces
 * (18e), the discovery declaration (19-20), the group flipped private, public,
 * private and public again by the settings save, with the PDS never more open
 * than the access record and each space credential issued exactly where the
 * caller's roles or a public policy allow (20b-20f), the events index (21-22), a rebuild of the
 * whole group from its DID (23), and, once cleanup is done, that no request
 * left this machine (24).
 *
 * Not covered: a member reading a private group's profile with the credential
 * the PDS issues them (20d asks for the credential only).
 *
 * The real $lib/groups modules run on workerd with a real D1 binding. Vite
 * bundles scripts/groups-e2e.worker.ts, a thin JSON entry onto those modules,
 * and Miniflare runs it. This file holds only the steps, the assertions and the
 * read-backs. It avoids `wrangler dev` and Miniflare's `getD1Database` proxy,
 * because both can hang in a dev container. D1 lives in a temporary directory
 * that is deleted on exit, so every row a check reads was written by this run.
 *
 * Writes are confirmed by reading them back from the PDS, never from the
 * writer's return value: events and the declaration with unauthenticated
 * `com.atproto.repo.getRecord` and `listRecords`, and space records with the
 * group's own session.
 *
 * Environment:
 *   E2E_PDS            the devnet PDS that serves spaces, where the run mints its group
 *   E2E_HANDLE_DOMAIN  the domain the group's handle is minted under (GROUP_HANDLE_DOMAIN)
 *   E2E_INVITE_CODE    an invite code for E2E_PDS, one use per run (GROUP_PDS_INVITE_CODE), or
 *   E2E_CREDENTIALS    an env file that holds E2E_INVITE_CODE and the three passwords below
 *   E2E_OWNER_DID      the person who owns the group
 *   E2E_OWNER_PASSWORD their password, for the sign-in they read with
 *   E2E_ADMIN_DID      a person who joins and is promoted to admin, on E2E_PDS
 *   E2E_ADMIN_PASSWORD their password, for their acceptance (checks 18b-18d) and their reads
 *   E2E_OUTSIDER_DID   a person who is never a member
 *   E2E_OUTSIDER_PASSWORD their password, for the sign-in they read with
 *   E2E_NOSPACES_DID   a person on a devnet PDS that serves no spaces (not E2E_PDS), for
 *                      checks 13u and 18e; no password, because nothing is written to
 *                      their repo
 *   E2E_PLC_URL        required: devnet's PLC directory, the only place a DID is
 *                      resolved, for a network no relay crawls
 * The run is for devnet only, and no request leaves this machine. E2E_PDS and
 * E2E_PLC_URL must be loopback URLs, or devnet names this run resolves to
 * 127.0.0.1 or ::1 alone (the devnet's scripts/https-run). Outside https-run,
 * checking such a name is a lookup through the system resolver, so a refused run
 * may first send a DNS query for it, and nothing else. Before any login the run
 * asks devnet's PLC for every fixture DID and stops on one it lacks or one hosted
 * off this machine, printing a REFUSED line for each. Then every request is
 * counted: the worker's pass a Miniflare outboundService and this driver's own
 * fetch is wrapped. A request to this machine goes through; any other is refused,
 * never sent, and printed as `REFUSED <driver|worker> <METHOD> <URL without its
 * query>`.
 * Check 24 reports the count.
 * Each run mints its own group, so nothing an earlier run wrote can stand in
 * for this run's writes, and each run leaves one did:plc behind on the devnet.
 * The app writes as a group only through the session its owner linked, and a
 * real link needs the deployment's OAuth client key. So the run links the group
 * with a stand-in (scripts/groups-e2e.oauth.ts, aliased over the OAuth client):
 * its session logs in with the password the run's create set, and every write
 * still goes through the app's linked branch. The password is made by the run
 * and never printed. The scope a real link carries is not exercised here; a walk through a deployed site with a
 * linked group covers it. The admin's acceptance and RSVP are written the same way,
 * through a stand-in for their own session that logs in with E2E_ADMIN_PASSWORD. The
 * no-spaces member's stand-in never logs in: it answers the scope a stock PDS
 * grants and refuses any request, so check 18e can show the app sent none.
 *
 * Cleanup runs in the `finally`. The group is left behind, so it undoes only
 * what shows outside the group: it deletes the public events, the admin's RSVP
 * to the seed should 13t or 13v stop before its cancel, and the admin's
 * acceptance should 18b-18d stop before they leave, and withdraws the
 * declaration. Then it re-reads each one and prints WARN for anything left.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { WEB_DIR, bundleWorker } from './groups-e2e.build.mjs';
import {
	createLedger,
	fixtureCheck,
	guardFetch,
	isLoopback,
	localNames,
	outboundHandler,
	settingRefusals
} from './groups-e2e.network.mjs';

/** Devnet names this run resolves to this machine, filled before any login. */
const localHosts = new Set();
/** Every request the run sends, from this driver and from the worker, for check 24. */
const ledger = createLedger(console.log, localHosts);
const nodeFetch = globalThis.fetch;
// Wrapped before the first request. A redirect comes back as an answer instead
// of being followed out of the ledger's sight.
globalThis.fetch = guardFetch(ledger, (input, init) =>
	nodeFetch(input, { ...init, redirect: 'manual' })
);

/** Read a required fixture setting, or stop before anything is written. */
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set; see the header of this script`);
	return value;
}

const PDS = required('E2E_PDS');
/** Devnet's PLC directory. scripts/groups-e2e.identity-resolver.ts asks it and
 *  nothing else, so a DID it lacks fails to resolve. */
const PLC_URL = required('E2E_PLC_URL');

/** The domain the run's group is minted under, as GROUP_HANDLE_DOMAIN is for
 *  the app. */
const HANDLE_DOMAIN = required('E2E_HANDLE_DOMAIN');
/** The owner, a member promoted to admin, and a non-member. The run writes to one
 *  of their repos only: the admin's acceptance, in the members space, which it
 *  deletes again. */
const ALICE = required('E2E_OWNER_DID');
const BOB = required('E2E_ADMIN_DID');
const MALLORY = required('E2E_OUTSIDER_DID');
/** Use case step 4's member, on a PDS that serves no spaces. */
const CAROL = required('E2E_NOSPACES_DID');

/** The about space's read policies. Expected values are written out, not
 *  imported from the app, so a check cannot pass just by agreeing with the code
 *  under test. The same holds for DECLARATION_COLLECTION and SEEDED_BUNDLE_SIZES. */
const READ_POLICY = {
	public: 'com.atproto.simplespace.defs#publicPolicy',
	private: 'com.atproto.simplespace.defs#memberListPolicy'
};

/** The visibility chosen at create. D1 does not store it, so each step that
 *  needs it is passed it. */
const CREATE_VISIBILITY = 'public';

/** The run's group label: new each run, and within the PDS's 18 characters. */
const GROUP_LABEL = `e2e-${Date.now().toString(36)}`;
/** Check 1's create, as the create form sends it. The account's password is the
 *  run's own, made here and never printed. */
const CREATE_DATA = {
	name: 'groups e2e',
	label: GROUP_LABEL,
	description: 'A group made by apps/web/scripts/groups-e2e.mjs for one run.',
	visibility: CREATE_VISIBILITY,
	requireApproval: true,
	locationName: 'e2e group place',
	rules: 'Be kind\nNo spam\nStay on topic',
	email: `groups-e2e+${GROUP_LABEL}@example.com`,
	password: randomBytes(24).toString('base64url')
};

/** The run's group, minted by check 1 with the app's own create. Each run leaves
 *  one did:plc behind on the devnet's PLC, which costs nothing there, and starts
 *  from an account no earlier run has touched. Set by `useGroup`. */
let GROUP_DID;
let GROUP_HANDLE;
/** The calendar space, written out like READ_POLICY rather than taken from the
 *  app, so a wrong type or key in the app's constant fails check 13c. */
let CALENDAR_SPACE_URI;

const EVENT_COLLECTION = 'community.lexicon.calendar.event';
const ACCESS_COLLECTION = 'group.opensocial.access';

/** One members-only event, written straight into the calendar space by this
 *  driver with no app code. The key is a valid TID, in case a host checks its
 *  format. */
const SEED_RKEY = '3me2emembersx';
const SEED_NAME = 'e2e members-only meeting (seed)';
/** Its space-form URI, written out like CALENDAR_SPACE_URI. */
let SEED_URI;
/** A valid key that nothing writes into the calendar space, for a read that
 *  must come back absent. */
const MADE_UP_RKEY = '3me2enothere';
/** A member's RSVP, as the app writes it into the calendar space. */
const RSVP_COLLECTION = 'community.lexicon.calendar.rsvp';
/** What the app tells a member whose PDS can't RSVP to a members-only event,
 *  written out. */
const RSVP_NO_SPACES = "Your PDS can't RSVP to members-only events yet, so nothing was saved.";
/** The URL a stand-in reauthorize() answers. Never fetched. */
const REAUTHORIZE_STAND_IN = 'http://groups-e2e.invalid/oauth/authorize?request_uri=e2e';

/** What the app tells a member of an unlinked group, written out. */
const NO_ACCESS_NOTICE =
	"Members-only events can't be shown: your sign-in doesn't let this site read the group's spaces.";

/** A calendar space under the group's DID that nothing ever creates: the check
 *  that reads it writes nothing, so the host never makes it. */
let NEVER_CREATED_SPACE;

/** Points the run's written-out URIs at the group check 1 minted. */
function useGroup(did, handle) {
	GROUP_DID = did;
	GROUP_HANDLE = handle;
	CALENDAR_SPACE_URI = `at://${did}/space/rsvp.atmo.group.calendar/self`;
	SEED_URI = `${CALENDAR_SPACE_URI}/${did}/${EVENT_COLLECTION}/${SEED_RKEY}`;
	NEVER_CREATED_SPACE = `at://${did}/space/rsvp.atmo.group.calendar/e2enevercreated`;
}

/** Keys a record would carry if it said who may read it. Placement says that,
 *  so neither container's copy of an event may carry one. */
const AUDIENCE_KEYS = ['visibility', 'privacy', 'private', 'audience', 'isPrivate'];
/** The record in the group's public repo that lets other apps find it. */
const DECLARATION_COLLECTION = 'group.opensocial.declaration';

/** Owner and admin hold all six permissions, a member holds none. */
const SEEDED_BUNDLE_SIZES = { owner: 6, admin: 6, member: 0 };

/** Only fills `request.url`. The host never resolves and is never connected to. */
const ORIGIN = 'http://groups-e2e.invalid';
/** Matches apps/web/wrangler.jsonc. */
const COMPATIBILITY_DATE = '2025-12-25';

const CREDENTIALS_PATH = process.env.E2E_CREDENTIALS?.trim() || null;

const results = [];

function record(ok, label, detail) {
	results.push({ ok, label, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
	return ok;
}

function note(text) {
	console.log(`      ${text}`);
}

/** A secret from the environment, else from the E2E_CREDENTIALS file. */
async function loadSecret(name) {
	const direct = process.env[name]?.trim();
	if (direct) return { path: name, value: direct };
	if (!CREDENTIALS_PATH) throw new Error(`set ${name}, or E2E_CREDENTIALS to a file that holds it`);
	const text = await readFile(CREDENTIALS_PATH, 'utf8').catch(() => '');
	const pattern = new RegExp(`^${name}=['"]?([^'"\\s]+)['"]?$`);
	for (const line of text.split('\n')) {
		const match = pattern.exec(line.trim());
		if (match) return { path: CREDENTIALS_PATH, value: match[1] };
	}
	throw new Error(`no ${name} in ${CREDENTIALS_PATH}`);
}

/** Logs in to the PDS, for the driver's direct reads and writes. Returns the
 *  session's DID and token. */
async function logIn(identifier, password) {
	const { status, body } = await pdsPost('com.atproto.server.createSession', {
		identifier,
		password
	});
	if (status !== 200) {
		const hint = status === 401 ? ' (the password is stale)' : '';
		throw new Error(`createSession ${identifier} failed: ${status} ${body.error ?? ''}${hint}`);
	}
	return { did: body.did, token: body.accessJwt };
}

/** Logs in as the run's group, with the password the create set. The group's
 *  writes still go through the app's credential path inside the Worker. */
async function logInAsGroup(password) {
	return (await logIn(GROUP_DID, password)).token;
}

/** Fails early if the admin's password is stale. Returns their session token,
 *  for reading and deleting their own acceptance without the app's code. */
async function checkAdminAccount(password) {
	const { did, token } = await logIn(BOB, password);
	if (did !== BOB) throw new Error(`the admin login is ${did}, not ${BOB}`);
	return token;
}

let miniflare;

/** Runs one operation on the real modules inside workerd. A refusal comes back
 *  as `{ ok: false, error }`, because several checks expect one. */
async function call(op, args = {}) {
	if (!miniflare) throw new Error('worker not started');
	const response = await miniflare.dispatchFetch(ORIGIN, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ op, args })
	});
	const body = await response.json().catch(() => ({}));
	if (body.ok === undefined) throw new Error(`worker op ${op} returned ${response.status}`);
	return body;
}

/** `call`, for the ops whose failure stops the run. */
async function must(op, args = {}) {
	const body = await call(op, args);
	if (!body.ok) {
		const stale = /\(401\)/.test(body.error.message) ? ' (the fixture password is stale)' : '';
		throw new Error(`${op} failed: ${body.error.name}: ${body.error.message}${stale}`);
	}
	return body.value;
}

/** Bundles the Worker (./groups-e2e.build.mjs) and starts it in Miniflare. */
async function startWorker(stateDir, adminPassword, inviteCode, passwords) {
	const started = Date.now();
	const outDir = join(stateDir, 'bundle');
	await bundleWorker(outDir, PLC_URL);

	// miniflare is not a direct dependency. It is resolved through wrangler, which
	// ships it, so it is not pinned twice.
	const req = createRequire(join(WEB_DIR, 'package.json'));
	const { Miniflare, fetch: miniflareFetch } = await import(
		createRequire(req.resolve('wrangler')).resolve('miniflare')
	);
	miniflare = new Miniflare({
		// Every subrequest the worker sends comes here first. A loopback one goes
		// out through Miniflare's own fetch, a redirect coming back as an answer so
		// its next hop passes here too; any other is refused.
		outboundService: outboundHandler(ledger, (request) =>
			miniflareFetch(request, { redirect: 'manual' })
		),
		// The built-in placeholder for `request.cf`. Left unset, Miniflare fetches
		// it from workers.cloudflare.com whenever its cache file is missing or old.
		cf: false,
		modules: true,
		modulesRoot: outDir,
		scriptPath: join(outDir, 'worker.js'),
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ['nodejs_compat'],
		d1Databases: { DB: 'groups-e2e' },
		kvNamespaces: ['OAUTH_SESSIONS'],
		bindings: {
			// What the app's create mints with, as on a deployment.
			GROUP_PDS_SERVICE: PDS,
			GROUP_HANDLE_DOMAIN: HANDLE_DOMAIN,
			GROUP_PDS_INVITE_CODE: inviteCode,
			// Only for the create's check that linking is configured. Nothing is
			// fetched from it: the stand-in links the group.
			OAUTH_PUBLIC_URL: ORIGIN,
			E2E_GROUP_SERVICE: PDS,
			E2E_ADMIN_PASSWORD: adminPassword,
			// Each person's login by DID, for the stand-in of the sign-in they read
			// with: every page read goes through the reader's own access.
			E2E_PASSWORDS: JSON.stringify(passwords)
		},
		defaultPersistRoot: stateDir
	});
	// Start now, so a startup failure is reported here and not on the first request.
	await miniflare.ready;
	const stop = () => {
		const closing = miniflare?.dispose();
		miniflare = undefined;
		return closing;
	};
	return { stop, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

/** Only the PDS's own `RecordNotFound` proves a record absent. A 5xx, a refused
 *  token or a repo the PDS does not host says nothing about the record. */
function notFound(read) {
	return read.error === 'RecordNotFound';
}

/** Whether an `access` record grants every role read on its own space and
 *  nothing else, in the standard's shape: `grants` of role and scopes, no
 *  `readRoles`. The space type is the URI's, so the check names no constant the
 *  app also uses. (Spec: FR-201, FR-214.) */
function grantsEveryRoleRead(value, spaceUri) {
	const spaceType = spaceUri?.split('/')[4];
	const expected = ['owner', 'admin', 'member'].map((role) => ({
		role,
		scopes: [`space:${spaceType}?action=read`]
	}));
	return (
		!!value && !('readRoles' in value) && JSON.stringify(value.grants) === JSON.stringify(expected)
	);
}

/** A PDS that serves no spaces refuses a space read itself: a 4xx, or 501 for
 *  a method it lacks. A RecordNotFound, or a credential it calls expired or
 *  revoked, comes from a PDS that serves spaces, and a 5xx says nothing. */
function refusesSpaceRead(read) {
	const spacesAnswer = ['RecordNotFound', 'JwtExpired', 'CredentialRevoked'];
	const refused = read.status === 501 || (read.status >= 400 && read.status < 500);
	return refused && !spacesAnswer.includes(read.error);
}

/** One XRPC query on the PDS, with `token` as the bearer when there is one.
 *  Answers the status and the JSON body, `{}` when the body is not JSON. */
async function pdsGet(nsid, params, token) {
	const url = new URL(`/xrpc/${nsid}`, PDS);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
	const response = await fetch(url, token ? { headers: { authorization: `Bearer ${token}` } } : {});
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** One XRPC procedure on the PDS, as `pdsGet`. */
async function pdsPost(nsid, input, token) {
	const response = await fetch(new URL(`/xrpc/${nsid}`, PDS), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(token ? { authorization: `Bearer ${token}` } : {})
		},
		body: JSON.stringify(input)
	});
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Unauthenticated read straight from the PDS. */
async function getRecord(repo, rkey, collection = EVENT_COLLECTION) {
	const { status, body } = await pdsGet('com.atproto.repo.getRecord', { repo, collection, rkey });
	return { status, ...body };
}

async function listRecords(repo) {
	const { status, body } = await pdsGet('com.atproto.repo.listRecords', {
		repo,
		collection: EVENT_COLLECTION,
		limit: 100
	});
	return { status, records: body.records ?? [] };
}

/** A record in one of the group's spaces, read with the group's session and not
 *  through the app's reader, so the check shares no code with the writer. */
async function spaceRecord(token, space, collection, rkey, repo = GROUP_DID) {
	const { status, body } = await pdsGet(
		'com.atproto.space.getRecord',
		{ space, repo, collection, rkey },
		token
	);
	return { status, ...body };
}

/** Every record of one collection in one of the group's spaces, read like
 *  `spaceRecord`. One page: the collections read this way stay small. */
async function spaceRecords(token, space, collection) {
	const { status, body } = await pdsGet(
		'com.atproto.space.listRecords',
		{ space, repo: GROUP_DID, collection, limit: 100 },
		token
	);
	return { status, records: body.records ?? [], cursor: body.cursor };
}

/** Writes a record into one of the group's spaces with the group's session,
 *  with no app code: the seed of the members-only slice. */
async function putSpaceRecord(token, space, collection, rkey, record) {
	const { status, body } = await pdsPost(
		'com.atproto.space.putRecord',
		{ space, repo: GROUP_DID, collection, rkey, record },
		token
	);
	return { status, ...body };
}

/** The requests in a worker op's log that named the calendar space. A write
 *  carries the space in its body, and nothing here writes, so the query is
 *  where a read names it. */
function calendarCalls(calls) {
	return calls.filter(
		(path) => new URL(path, ORIGIN).searchParams.get('space') === CALENDAR_SPACE_URI
	);
}

/** The requests among them that read: every one but the credential exchange a
 *  read with someone's own access may begin with (a delegation token, then the
 *  credential), which is kept per person and space and so comes and goes with
 *  the credential's lifetime. */
function reads(calls) {
	return calls.filter(
		(path) =>
			!path.startsWith('/xrpc/com.atproto.space.getDelegationToken?') &&
			!path.startsWith('/xrpc/com.atproto.space.getSpaceCredential?')
	);
}

/** The calendar listings among them: the one read the slice is allowed. */
function calendarListings(calls) {
	return calendarCalls(calls).filter((path) =>
		path.startsWith('/xrpc/com.atproto.space.listRecords?')
	);
}

const ACCEPTANCE_COLLECTION = 'group.opensocial.acceptance';

/** A user's own request for a space credential, as another app would make it:
 *  a delegation token from their session, then `getSpaceCredential` signed by a
 *  key made for the request. Shares no code with the app. (Spec: SC-202.) */
async function spaceCredentialRequest(token, space) {
	const delegated = await pdsGet('com.atproto.space.getDelegationToken', { space }, token);
	if (delegated.status !== 200) {
		return { stage: 'getDelegationToken', status: delegated.status, error: delegated.body.error };
	}
	const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
		'sign'
	]);
	const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const compressed = new Uint8Array([raw[64] & 1 ? 0x03 : 0x02, ...raw.slice(1, 33)]);
	const keyId = `did:key:z${base58(new Uint8Array([0x80, 0x24, ...compressed]))}`;
	const authorization = `Bearer ${delegated.body.token}`;
	const params = `("authorization");keyid="${keyId}"`;
	const signed = new TextEncoder().encode(
		`"authorization": ${authorization}\n"@signature-params": ${params}`
	);
	const signature = new Uint8Array(
		await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, signed)
	);
	const response = await fetch(new URL('/xrpc/com.atproto.space.getSpaceCredential', PDS), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			authorization,
			'signature-input': `atproto-space=${params}`,
			signature: `atproto-space=:${Buffer.from(signature).toString('base64')}:`
		},
		body: JSON.stringify({ space })
	});
	const body = await response.json().catch(() => ({}));
	return {
		stage: 'getSpaceCredential',
		status: response.status,
		error: body.error,
		issued: typeof body.credential === 'string'
	};
}

/** Base58btc, as a did:key names its key. */
function base58(bytes) {
	const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
	let n = BigInt(`0x${Buffer.from(bytes).toString('hex') || '0'}`);
	let out = '';
	while (n > 0n) {
		out = alphabet[Number(n % 58n)] + out;
		n /= 58n;
	}
	for (const byte of bytes) {
		if (byte !== 0) break;
		out = `1${out}`;
	}
	return out;
}

/** The admin's own acceptance in the members space, read with their own session,
 *  so the check shares no code with the app's writer or its reader. */
async function ownAcceptance(token, space) {
	return spaceRecord(token, space, ACCEPTANCE_COLLECTION, 'self', BOB);
}

/** Deletes the admin's acceptance with their own session, for cleanup. */
async function deleteOwnAcceptance(token, space) {
	const { status } = await pdsPost(
		'com.atproto.space.deleteRecord',
		{ space, repo: BOB, collection: ACCEPTANCE_COLLECTION, rkey: 'self' },
		token
	);
	return status;
}

/** Deletes the admin's RSVP to the members-only seed with their own session,
 *  for cleanup, and reads it back the same way. */
async function deleteOwnRsvp(token) {
	const rsvp = {
		space: CALENDAR_SPACE_URI,
		repo: BOB,
		collection: RSVP_COLLECTION,
		rkey: SEED_RKEY
	};
	await pdsPost('com.atproto.space.deleteRecord', rsvp, token);
	return spaceRecord(token, rsvp.space, rsvp.collection, rsvp.rkey, BOB);
}

/** A space's read policy as the host reports it. */
async function spaceReadPolicy(token, space) {
	const { status, body } = await pdsGet('com.atproto.simplespace.getSpace', { space }, token);
	return { status, readPolicy: body.readPolicy?.$type ?? null, error: body.error };
}

/** The PDS's own member list for a space, separate from our `membership`
 *  records. `listMembers` is owner-only, and the group is the owner. */
async function spaceMemberList(token, space) {
	const { status, body } = await pdsGet('com.atproto.simplespace.listMembers', { space }, token);
	return { status, members: body.members ?? [], error: body.error };
}

/** The `at://<authority>/...` a record actually landed under. */
function authorityOf(uri) {
	return String(uri).slice('at://'.length).split('/')[0];
}

/** A space listing with no credential at all, as any stranger would ask. */
async function anonymousSpaceList(space) {
	const { status, body } = await pdsGet('com.atproto.space.listRecords', {
		space,
		repo: GROUP_DID,
		collection: EVENT_COLLECTION
	});
	return { status, error: body.error, records: body.records ?? [] };
}

/** Runs a worker op and adds every request it sent through the group's session,
 *  so "nothing was written" is a count of what was sent. */
async function traced(op, args) {
	const { total: from } = await must('groupCalls', {});
	const result = await call(op, args);
	const { calls } = await must('groupCalls', { from });
	return { ...result, calls };
}

/** The record writes among a trace's requests, by method. */
function writesIn(calls) {
	return calls
		.map((path) => path.split('?')[0].replace(/^\/xrpc\//, ''))
		.filter((nsid) =>
			/^com\.atproto\.(repo|space)\.(createRecord|putRecord|deleteRecord|applyWrites)$/.test(nsid)
		);
}

/** A value with every object's keys sorted, so two records compare by content
 *  and not by the key order a host stores them in. */
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, canonical(value[key])])
		);
	}
	return value;
}

/** Every key at any depth of a record. */
function keysDeep(value) {
	if (Array.isArray(value)) return value.flatMap(keysDeep);
	if (value && typeof value === 'object') {
		return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
	}
	return [];
}

/** One PNG chunk: length, type, data and the CRC over type and data. */
function pngChunk(type, data) {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed));
	return Buffer.concat([length, typed, crc]);
}

/** A 1x1 PNG in a colour picked per run, so its CID is new each run and no
 *  public record, from this run or an earlier one, cites the same bytes. */
function runPng() {
	const [r, g, b] = randomBytes(3);
	const header = Buffer.alloc(13);
	header.writeUInt32BE(1, 0);
	header.writeUInt32BE(1, 4);
	header[8] = 8; // bits per channel
	header[9] = 2; // RGB
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(Buffer.from([0, r, g, b]))),
		pngChunk('IEND', Buffer.alloc(0))
	]);
}

/** A blob read anonymously, the way any CDN or stranger would fetch it. */
async function anonymousBlob(cid) {
	const url = new URL('/xrpc/com.atproto.sync.getBlob', PDS);
	url.searchParams.set('did', GROUP_DID);
	url.searchParams.set('cid', String(cid));
	const response = await fetch(url);
	const body = response.ok ? {} : await response.json().catch(() => ({}));
	return { status: response.status, error: body.error };
}

/** A blob read from one of the group's spaces with the group's session. */
async function spaceBlob(token, space, cid) {
	const url = new URL('/xrpc/com.atproto.space.getBlob', PDS);
	url.searchParams.set('space', space);
	url.searchParams.set('repo', GROUP_DID);
	url.searchParams.set('cid', String(cid));
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	if (!response.ok) {
		const body = await response.json().catch(() => ({}));
		return { status: response.status, error: body.error, bytes: null };
	}
	return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

/** A 1x1 PNG, the smallest image the upload takes. */
const PNG_1PX = [
	137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
	0, 31, 21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 96, 0, 2, 0, 0, 5, 0, 1, 122, 94,
	171, 63, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130
];

/** A record in the shape atmo's event editor builds (buildEventRecord in
 *  packages/ui), unlisted so a run never surfaces in discovery. */
function eventRecord(name, { country, createdAt, image } = {}) {
	return {
		createdWith: 'https://atmo.rsvp',
		name,
		description: 'Written by apps/web/scripts/groups-e2e.mjs. Deleted in the same run.',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled',
		startsAt: '2026-10-04T17:00:00.000Z',
		endsAt: '2026-10-04T19:00:00.000Z',
		timezone: 'UTC',
		createdAt: createdAt ?? new Date().toISOString(),
		theme: { name: 'minimal', accentColor: 'cyan', baseColor: 'mist' },
		...(country && {
			locations: [{ $type: 'community.lexicon.location.address', name: 'e2e place', country }]
		}),
		...(image && {
			media: [{ role: 'thumbnail', content: image, aspect_ratio: { width: 1, height: 1 } }]
		}),
		preferences: { showInDiscovery: false }
	};
}

/** Stops the run before any login, with nothing yet to clean up, when a setting
 *  or a fixture is off this machine. Otherwise notes where the fixtures live. */
async function refuseOffMachine() {
	const asked = [PDS, PLC_URL].filter((url) => !isLoopback(url) && URL.canParse(url));
	const hostnames = asked.map((u) => new URL(u).hostname).filter(Boolean);
	for (const name of await localNames(hostnames)) localHosts.add(name);
	let refusals = settingRefusals({ E2E_PDS: PDS, E2E_PLC_URL: PLC_URL }, localHosts);
	if (refusals.length === 0) {
		const fixtures = await fixtureCheck({
			plcUrl: PLC_URL,
			spacesPds: PDS,
			fixtures: [
				['E2E_OWNER_DID', ALICE],
				['E2E_ADMIN_DID', BOB],
				['E2E_OUTSIDER_DID', MALLORY],
				['E2E_NOSPACES_DID', CAROL]
			],
			fetch,
			names: localHosts
		});
		refusals = fixtures.refusals;
		if (fixtures.note) note(fixtures.note);
	}
	if (refusals.length === 0) return;
	for (const line of refusals) console.log(line);
	console.log('');
	console.log('refused before any login: nothing was written, and nothing left this machine');
	process.exit(2);
}

async function main() {
	console.log('groups e2e');
	console.log(`  pds     ${PDS}`);
	console.log(`  plc     ${PLC_URL} (devnet only)`);
	console.log(`  group   ${GROUP_LABEL}.${HANDLE_DOMAIN}, minted by this run`);
	console.log(`  humans  owner ${ALICE}, admin ${BOB}, non-member ${MALLORY}`);
	console.log(`          no-spaces member ${CAROL}`);
	console.log('');

	await refuseOffMachine();
	ledger.startRun();

	const { path, value: adminPassword } = await loadSecret('E2E_ADMIN_PASSWORD');
	note(`fixture credentials loaded from ${path}`);
	const bobToken = await checkAdminAccount(adminPassword);
	note(`${BOB} authenticates for their own acceptance`);
	const { value: inviteCode } = await loadSecret('E2E_INVITE_CODE');

	const stateDir = await mkdtemp(join(tmpdir(), 'groups-e2e-'));
	let worker;
	let group;
	/** A worker op on the run's group: `must`, `call` and `traced` with the
	 *  group's id filled in. */
	const op = (name, args = {}) => must(name, { groupId: group.id, ...args });
	const tryOp = (name, args = {}) => call(name, { groupId: group.id, ...args });
	const tracedOp = (name, args = {}) => traced(name, { groupId: group.id, ...args });
	/** The driver's own session as the group, for reading its spaces directly. */
	let groupToken;
	const written = [];
	let membersSpaceUri;
	let aboutSpaceUri;
	let calendarSpaceUri;
	/** Set once the group may be declared, so the `finally` withdraws it. */
	let declared = false;
	/** Set once the admin's acceptance may exist, so the `finally` deletes it. */
	let acceptanceWritten = false;
	/** Set while the admin's RSVP to the seed may exist, so the `finally` deletes it. */
	let rsvpWritten = false;
	try {
		const passwords = {
			[ALICE]: (await loadSecret('E2E_OWNER_PASSWORD')).value,
			[BOB]: adminPassword,
			[MALLORY]: (await loadSecret('E2E_OUTSIDER_PASSWORD')).value
		};
		worker = await startWorker(stateDir, adminPassword, inviteCode, passwords);
		note(`worker bundled and ready in ${worker.seconds}s (workerd, empty D1 under ${stateDir})`);
		console.log('');

		// 1. create ------------------------------------------------------------
		// The create form's own path: it mints the account, makes the three spaces,
		// writes the profile, rules, access records, space index, the owner's
		// membership and the authz config, lists the owner, and declares the
		// public group. The checks after this one read back what it wrote.
		const minted = await must('runCreateGroup', { ownerDid: ALICE, data: CREATE_DATA });
		if (minted.groupDid) useGroup(minted.groupDid, minted.handle);
		declared = minted.groupDid !== null;
		if (!minted.ok) throw new Error(`the create failed: ${minted.error}`);
		groupToken = await logInAsGroup(CREATE_DATA.password);
		await must('linkGroup', {
			groupDid: GROUP_DID,
			personDid: ALICE,
			password: CREATE_DATA.password
		});
		note(`${GROUP_HANDLE} is ${GROUP_DID}, linked by ${ALICE} through the stand-in session`);
		group = await must('groupByDid', { groupDid: GROUP_DID });
		membersSpaceUri = group.members_space_uri;
		aboutSpaceUri = group.about_space_uri;
		calendarSpaceUri = CALENDAR_SPACE_URI;
		const members = await op('listMembers');
		const bundles = await op('rolePermissions');
		const sizes = Object.fromEntries(Object.entries(bundles).map(([r, p]) => [r, p.length]));
		const owners = members.filter((m) => m.role === 'owner');
		const seededBundles =
			Object.keys(sizes).length === Object.keys(SEEDED_BUNDLE_SIZES).length &&
			Object.entries(SEEDED_BUNDLE_SIZES).every(([role, n]) => sizes[role] === n);
		const ownerLists = await Promise.all(
			[aboutSpaceUri, membersSpaceUri, calendarSpaceUri].map((space) =>
				spaceMemberList(groupToken, space)
			)
		);
		const ownerEntries = ownerLists.map((list) => list.members.find((m) => m.did === ALICE));
		record(
			minted.hasRecoveryKey === true &&
				GROUP_HANDLE === `${GROUP_LABEL}.${HANDLE_DOMAIN}` &&
				members.length === 1 &&
				owners.length === 1 &&
				owners[0].did === ALICE &&
				seededBundles &&
				aboutSpaceUri?.startsWith(`at://${GROUP_DID}/space/`) &&
				membersSpaceUri?.startsWith(`at://${GROUP_DID}/space/`) &&
				ownerEntries.every((entry) => entry?.read === true && entry?.write === true),
			"the app's create mints the group with one owner, three pared role bundles, and the owner on all three spaces' member lists, read and write",
			`${GROUP_HANDLE} (${GROUP_DID}), recovery key handed back ${minted.hasRecoveryKey}; ` +
				`roster ${members.length} (${owners.length} owner: ${owners[0]?.did}), ` +
				Object.entries(sizes)
					.map(([role, n]) => `${role} ${n}`)
					.join(' / ') +
				`; owner on the about list ${JSON.stringify(ownerEntries[0])}, members list ${JSON.stringify(ownerEntries[1])}, calendar list ${JSON.stringify(ownerEntries[2])}`
		);

		// The admin, through the roster as the members page adds and promotes: a
		// membership record and the three member lists, then the role.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
		note(`${BOB} admitted and promoted to admin through the roster`);

		// 4. the owner's event is the group's record ----------------------------
		const created = await op('writeGroupEvent', {
			callerDid: ALICE,
			placement: 'everyone',
			intent: 'create',
			record: eventRecord('e2e sunrise paddle', { country: 'US' })
		});
		written.push(created.rkey);
		const asPersisted = await getRecord(GROUP_DID, created.rkey);
		const inOwnersRepo = await getRecord(ALICE, created.rkey);
		const address = asPersisted.value?.locations?.[0];
		record(
			asPersisted.status === 200 &&
				authorityOf(asPersisted.uri) === GROUP_DID &&
				asPersisted.value?.name === 'e2e sunrise paddle' &&
				address?.$type === 'community.lexicon.location.address' &&
				address?.country === 'US' &&
				notFound(inOwnersRepo),
			"owner's event is authored by the GROUP DID, not by the owner",
			`read back ${asPersisted.uri} (cid ${asPersisted.cid}); author ${authorityOf(asPersisted.uri)}; ` +
				`location ${address?.name}/${address?.country}; ` +
				`same rkey in the owner's repo: ${inOwnersRepo.status === 200 ? 'PRESENT' : (inOwnersRepo.error ?? inOwnersRepo.status)}`
		);

		// 5a. an admin with no group session of their own -----------------------
		// A write as the group goes out only on the acting person's own session,
		// so the creator's stored one never serves the admin (TS, 2026-10-15).
		const { total: beforeUnlinked } = await must('groupWrites', {});
		const unlinked = await tryOp('writeGroupEvent', {
			callerDid: BOB,
			placement: 'everyone',
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord('e2e sunrise paddle (no session of his own)', { country: 'US' })
		});
		const unlinkedWrites = await must('groupWrites', { from: beforeUnlinked });
		const afterUnlinked = await getRecord(GROUP_DID, created.rkey);
		record(
			unlinked.ok === false &&
				unlinked.error.name === 'GroupCredentialError' &&
				unlinked.error.personDid === BOB &&
				unlinked.error.standInHost === false &&
				unlinkedWrites.writes.length === 0 &&
				afterUnlinked.cid === asPersisted.cid,
			"an admin who has linked no group session is refused, and the creator's session writes nothing for him",
			`${unlinked.error?.name} for ${unlinked.error?.personDid}; ${unlinkedWrites.writes.length} write(s) as the group; ` +
				`record at cid ${afterUnlinked.cid}`
		);

		// 5. an admin edits an event they did not create -------------------------
		// Admins edit on their own group session, so the author must not change. On
		// the stand-in the only way in is the group's own login, so the harness
		// stores the admin's session as his own link would; a host cutting it to his
		// roles is for a run against a real group host.
		await must('linkGroup', {
			groupDid: GROUP_DID,
			personDid: BOB,
			password: CREATE_DATA.password
		});
		const { total: beforeEdit } = await must('groupWrites', {});
		const editedName = 'e2e sunrise paddle (rescheduled by admin bob)';
		const edited = await op('writeGroupEvent', {
			callerDid: BOB,
			placement: 'everyone',
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord(editedName, { country: 'US', createdAt: asPersisted.value?.createdAt })
		});
		const adminEditWrites = await must('groupWrites', { from: beforeEdit });
		const afterEdit = await getRecord(GROUP_DID, created.rkey);
		const inAdminsRepo = await getRecord(BOB, created.rkey);
		const adminsEvents = await listRecords(BOB);
		const adminsCopies = adminsEvents.records.filter(
			(r) => r.uri.endsWith(`/${created.rkey}`) || r.value?.name === editedName
		);
		record(
			edited.repo === GROUP_DID &&
				afterEdit.status === 200 &&
				authorityOf(afterEdit.uri) === GROUP_DID &&
				afterEdit.value?.name === editedName &&
				afterEdit.cid !== asPersisted.cid &&
				notFound(inAdminsRepo) &&
				adminsEvents.status === 200 &&
				adminsCopies.length === 0 &&
				adminEditWrites.by.length > 0 &&
				adminEditWrites.by.every((person) => person === BOB),
			'admin edits an event they did not create, on his own group session; the author is still the GROUP DID',
			`edit landed as "${afterEdit.value?.name}" at ${afterEdit.uri} (cid ${asPersisted.cid} -> ${afterEdit.cid}); ` +
				`written on ${[...new Set(adminEditWrites.by)].join(', ') || 'no'} session(s); ` +
				`author ${authorityOf(afterEdit.uri)}, not the editing admin ${BOB}; ` +
				`admin's own repo: ${inAdminsRepo.error ?? inAdminsRepo.status} for that rkey, ` +
				`${adminsCopies.length} copies among ${adminsEvents.records.length} ${EVENT_COLLECTION} record(s)`
		);

		// 6. a non-member tries the same edit ------------------------------------
		const refused = await tryOp('writeGroupEvent', {
			callerDid: MALLORY,
			placement: 'everyone',
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord('e2e sunrise paddle (hijacked)', { country: 'US' })
		});
		const afterRefusal = await getRecord(GROUP_DID, created.rkey);
		record(
			refused.ok === false &&
				refused.error.name === 'GroupPermissionError' &&
				refused.error.reason === 'MANAGE_EVENTS required' &&
				afterRefusal.cid === afterEdit.cid &&
				afterRefusal.value?.name === editedName,
			"non-member's identical edit is refused",
			`${refused.error?.name}: ${refused.error?.message}; record unchanged at cid ${afterRefusal.cid}`
		);

		// 9. a cover image -----------------------------------------------------------
		// The editor uploads the image first, into the group's repo, then cites it
		// in the record. The PDS serves the blob only once a record cites it.
		const image = await op('uploadGroupEventImage', {
			callerDid: ALICE,
			intent: 'create',
			bytes: PNG_1PX,
			mimeType: 'image/png'
		});
		const withImage = await op('writeGroupEvent', {
			callerDid: ALICE,
			placement: 'everyone',
			intent: 'create',
			record: eventRecord('e2e paddle, with a cover image', { country: 'US', image })
		});
		written.push(withImage.rkey);
		const persistedWithImage = await getRecord(GROUP_DID, withImage.rkey);
		const cited = persistedWithImage.value?.media?.[0]?.content?.ref?.$link;
		const blob = await anonymousBlob(cited);
		record(
			persistedWithImage.status === 200 &&
				authorityOf(persistedWithImage.uri) === GROUP_DID &&
				cited === image?.ref?.$link &&
				blob.status === 200,
			"an event's cover image is uploaded into the GROUP repo, and its record cites it",
			`${persistedWithImage.uri} cites ${cited}; uploaded ${image?.ref?.$link}; ` +
				`getBlob from the group's repo: ${blob.status}`
		);

		// 10. the group's public face, as records --------------------------------
		// Only a live PDS can prove the profile and rules read back, because the PDS
		// defines the com.atproto.space.* parameters and the space URI form.
		note(`about space    ${aboutSpaceUri}`);
		note(`members space  ${membersSpaceUri}`);
		note(`calendar space ${calendarSpaceUri}`);
		const startPolicy = await spaceReadPolicy(groupToken, aboutSpaceUri);
		const about = await op('readGroupAbout');
		record(
			startPolicy.readPolicy === READ_POLICY[CREATE_VISIBILITY] &&
				about.profile?.name === CREATE_DATA.name &&
				about.profile?.locationName === CREATE_DATA.locationName &&
				// From the visibility and require_approval, never from the form.
				about.profile?.joinPolicy === 'approval' &&
				about.rules.map((rule) => rule.text).join('|') === 'Be kind|No spam|Stay on topic',
			'the create’s profile and rules read back out of the about space with the group’s own session',
			`read policy ${startPolicy.readPolicy}; joinPolicy ${about.profile?.joinPolicy}; ` +
				`${about.rules.length} rule(s); first rule ${about.rules[0]?.uri}`
		);

		// 10b. the about space's access record says the visibility ----------------
		// The standard keeps visibility in this record, but a simplespace host
		// enforces the read policy and never reads the record, so the record must
		// say what the policy says.
		const aboutAccess = await spaceRecord(groupToken, aboutSpaceUri, ACCESS_COLLECTION, 'self');
		record(
			aboutAccess.status === 200 &&
				aboutAccess.value?.public === (startPolicy.readPolicy === READ_POLICY.public) &&
				grantsEveryRoleRead(aboutAccess.value, aboutSpaceUri),
			'the about space’s access record says what its read policy says, and grants every role read',
			`read policy ${startPolicy.readPolicy}; access public ${aboutAccess.value?.public}, ` +
				`grants ${JSON.stringify(aboutAccess.value?.grants)}`
		);

		// 11. a rule's citation survives an edit to another rule ------------------
		// A writer that rewrote the whole list would pass check 10 and still break
		// every existing citation of a rule.
		const urisBefore = about.rules.map((rule) => rule.uri);
		const secondRules = await op('setGroupRules', {
			callerDid: ALICE,
			rules: 'Be kind\nNo self-promotion\nStay on topic'
		});
		const afterEditAbout = await op('readGroupAbout');
		const urisAfter = afterEditAbout.rules.map((rule) => rule.uri);
		record(
			urisAfter[0] === urisBefore[0] &&
				urisAfter[2] === urisBefore[2] &&
				urisAfter[1] !== urisBefore[1] &&
				secondRules.created.length === 1 &&
				secondRules.deleted.length === 1 &&
				afterEditAbout.rules.map((rule) => rule.text).join('|') ===
					'Be kind|No self-promotion|Stay on topic',
			'editing one rule leaves the other two rules’ URIs byte-identical',
			`kept ${secondRules.kept.length}, created ${secondRules.created.length}, ` +
				`deleted ${secondRules.deleted.length}; rule 1 ${urisBefore[0] === urisAfter[0] ? 'unchanged' : 'MOVED'}`
		);

		// 12. the row is a cache of the records ------------------------------------
		// The row has no visibility column, so a rebuild has nothing to guess.
		await op('corruptGroupCache');
		const rebuilt = await op('rebuildGroupCache');
		record(
			rebuilt.outcome === 'repaired' &&
				rebuilt.row.name === CREATE_DATA.name &&
				rebuilt.row.description === CREATE_DATA.description &&
				rebuilt.row.location_name === CREATE_DATA.locationName &&
				rebuilt.row.require_approval === 1 &&
				!('visibility' in rebuilt.row),
			'a corrupted cache rebuilds from records, and the row carries no visibility',
			`name "${rebuilt.row.name}"; row columns ${Object.keys(rebuilt.row).length}; ` +
				`${rebuilt.rules} rule record(s)`
		);

		// 13. the roster is records ------------------------------------------------
		// The owner's record from the create and the admin's from the roster, read
		// back through the app's reader and straight from the PDS. That proves the
		// records exist and that a DID works as a record key.

		const recorded = await op('recordedRoster', { did: BOB });
		const bobsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.membership',
			BOB
		);
		const accessRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.access',
			'self'
		);
		record(
			recorded.source === 'records' &&
				recorded.roster.map((entry) => `${entry.did}/${entry.role}`).join(' ') ===
					`${ALICE}/owner ${BOB}/admin` &&
				recorded.hasAccess === true &&
				// Keyed by the member DID, and the app's reader agrees with the PDS.
				bobsRecord.status === 200 &&
				bobsRecord.value?.member === BOB &&
				JSON.stringify(bobsRecord.value?.roles) === JSON.stringify(['admin']) &&
				accessRecord.status === 200 &&
				accessRecord.value?.public === false &&
				grantsEveryRoleRead(accessRecord.value, membersSpaceUri),
			'the roster is membership records in the members space, keyed by member DID',
			`source ${recorded.source}; ${recorded.roster.length} member(s) ` +
				`(${recorded.roster.map((e) => e.role).join(', ')}); ` +
				`${BOB} read straight off the PDS at rkey=${BOB} as ${JSON.stringify(bobsRecord.value?.roles)}; ` +
				`access record grants ${JSON.stringify(accessRecord.value?.grants)}, ` +
				`public ${accessRecord.value?.public}`
		);

		// 13b. the members space indexes all three spaces ----------------------------
		// One entry per space, the two well-known ones included. The key is a TID,
		// so a writer that did not list the index first would add a second entry on
		// every write: a write after the create's must add nothing.
		const indexWrite = await op('writeSpaceIndex', {
			callerDid: ALICE,
			calendarSpaceUri
		});
		const spaceIndex = await spaceRecords(groupToken, membersSpaceUri, 'group.opensocial.space');
		const indexedSpaces = spaceIndex.records.map((entry) => entry.value?.space).sort();
		record(
			spaceIndex.status === 200 &&
				spaceIndex.records.length === 3 &&
				JSON.stringify(indexedSpaces) ===
					JSON.stringify([aboutSpaceUri, membersSpaceUri, CALENDAR_SPACE_URI].sort()) &&
				indexWrite.added.length === 0 &&
				indexWrite.removed.length === 0,
			'the members space indexes all three spaces, one entry each',
			`listRecords ${spaceIndex.status}: ${spaceIndex.records.length} group.opensocial.space ` +
				`record(s) for ${indexedSpaces.join(', ')}; a second write added ` +
				`${indexWrite.added.length} and removed ${indexWrite.removed.length}`
		);

		// 13c. the calendar space is the members' alone ------------------------------
		// It holds members-only events, so its read policy is the member list even
		// for this public group: the about space's policy here would let any signed-in
		// account read them. The policy is read from the host, not taken from what
		// provisioning sent. Its member list holds the same members as the members
		// space's, read and write, since every role's access grants read there too.
		// (Spec: FR-214.)
		const calendarPolicy = await spaceReadPolicy(groupToken, calendarSpaceUri);
		const calendarAccess = await spaceRecord(
			groupToken,
			calendarSpaceUri,
			ACCESS_COLLECTION,
			'self'
		);
		const calendarMembers = await spaceMemberList(groupToken, calendarSpaceUri);
		const rosterList = await spaceMemberList(groupToken, membersSpaceUri);
		const didsOf = (list) =>
			list.members
				.map((m) => m.did)
				.sort()
				.join(',');
		record(
			CREATE_VISIBILITY === 'public' &&
				calendarPolicy.status === 200 &&
				calendarPolicy.readPolicy === READ_POLICY.private &&
				calendarAccess.status === 200 &&
				calendarAccess.value?.public === false &&
				grantsEveryRoleRead(calendarAccess.value, calendarSpaceUri) &&
				calendarMembers.status === 200 &&
				calendarMembers.members.length > 0 &&
				calendarMembers.members.every((m) => m.read === true && m.write === true) &&
				didsOf(calendarMembers) === didsOf(rosterList),
			'the calendar space is member-list read for a public group, holds access/self not ' +
				"public, and lists the members space's members, read and write",
			`${calendarSpaceUri}: getSpace ${calendarPolicy.status} read policy ` +
				`${calendarPolicy.readPolicy ?? calendarPolicy.error}; access/self ` +
				`${calendarAccess.status} public ${calendarAccess.value?.public} grants ` +
				`${JSON.stringify(calendarAccess.value?.grants)}; listMembers ${calendarMembers.status}: ` +
				`${calendarMembers.members.length} member(s), the members space ${rosterList.members.length}` +
				`${calendarMembers.error ? ` (${calendarMembers.error})` : ''}`
		);

		// 13d-13h. the members-only slice --------------------------------------------
		// What the events tab reads from the calendar space, viewer by viewer. One
		// members-only event is seeded first, by a raw putRecord as the group with no
		// app code. Each read is the app's own, behind its own roster check, and
		// comes back with every request it sent through the group's session, so "no
		// read" is a count.
		const seedPut = await putSpaceRecord(
			groupToken,
			CALENDAR_SPACE_URI,
			EVENT_COLLECTION,
			SEED_RKEY,
			{
				$type: EVENT_COLLECTION,
				...eventRecord(SEED_NAME, { createdAt: '2026-10-06T12:00:00.000Z' }),
				description: 'Members-only seed for apps/web/scripts/groups-e2e.mjs.'
			}
		);
		if (seedPut.status !== 200) {
			throw new Error(`seeding ${SEED_URI} failed: ${seedPut.status} ${seedPut.error ?? ''}`);
		}
		note(`members-only seed ${SEED_URI}`);
		const seed = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, SEED_RKEY);
		const listedEvents = await spaceRecords(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION);
		// The live listing carries the key and no uri; a uri is read too, in case.
		const listedKeys = listedEvents.records
			.map((r) => r.rkey ?? String(r.uri).split('/').pop())
			.sort();

		// 13d. a member reads it ---------------------------------------------------
		const memberSlice = await op('membersOnlySlice', { did: BOB });
		const memberEvents = memberSlice.slice?.events ?? [];
		const seedRead = memberEvents.filter((e) => e.rkey === SEED_RKEY);
		const memberListings = calendarListings(memberSlice.sliceCalls);
		record(
			memberSlice.onRoster === true &&
				seed.status === 200 &&
				listedEvents.status === 200 &&
				memberSlice.slice?.notice === null &&
				seedRead.length === 1 &&
				seedRead[0].uri === SEED_URI &&
				seedRead[0].space === CALENDAR_SPACE_URI &&
				seedRead[0].cid === seed.cid &&
				seedRead[0].value?.name === SEED_NAME &&
				JSON.stringify(memberEvents.map((e) => e.rkey).sort()) === JSON.stringify(listedKeys) &&
				memberListings.length >= 1 &&
				reads(memberSlice.sliceCalls).length === memberListings.length &&
				memberSlice.groupCalls.length === 0,
			'the members-only slice of a roster member holds the seed at its space-form URI, read live from the calendar space',
			`${BOB} on the roster ${memberSlice.onRoster}; ${memberEvents.length} event(s), the seed at ` +
				`${seedRead[0]?.uri} (space ${seedRead[0]?.space}; cid ` +
				`${seedRead[0]?.cid === seed.cid ? 'as the PDS has it' : `${seedRead[0]?.cid}, the PDS has ${seed.cid}`}); ` +
				`the PDS lists ${listedKeys.length} event(s) there; the read sent ` +
				`${reads(memberSlice.sliceCalls).length} read(s) with ${BOB}'s own access, ${memberListings.length} of them ` +
				`a calendar listRecords, and ${memberSlice.groupCalls.length} request(s) as the group`
		);

		// 13e. a signed-in non-member causes no read ----------------------------
		// The viewer's standing is read from the members space as for any page; the
		// calendar space must not be named once, in the standing or the slice.
		const strangerSlice = await op('membersOnlySlice', { did: MALLORY });
		record(
			strangerSlice.onRoster === false &&
				strangerSlice.slice === null &&
				strangerSlice.sliceCalls.length === 0 &&
				calendarCalls(strangerSlice.calls).length === 0,
			'the members-only slice of a signed-in non-member holds nothing, and no calendar space call was made',
			`${MALLORY} on the roster ${strangerSlice.onRoster}; slice ${JSON.stringify(strangerSlice.slice)}; ` +
				`${strangerSlice.sliceCalls.length} request(s) sent for the slice, ` +
				`${calendarCalls(strangerSlice.calls).length} to the calendar space of ` +
				`${strangerSlice.calls.length} in the whole read`
		);

		// 13f. and neither does an anonymous visitor -------------------------------
		const anonymousSlice = await op('membersOnlySlice', { did: null });
		record(
			anonymousSlice.onRoster === false &&
				anonymousSlice.slice === null &&
				anonymousSlice.sliceCalls.length === 0 &&
				calendarCalls(anonymousSlice.calls).length === 0,
			'the members-only slice of an anonymous visitor holds nothing, and no calendar space call was made',
			`slice ${JSON.stringify(anonymousSlice.slice)}; ${anonymousSlice.sliceCalls.length} request(s) ` +
				`sent for the slice, ${calendarCalls(anonymousSlice.calls).length} to the calendar space of ` +
				`${anonymousSlice.calls.length} in the whole read`
		);

		// 13g. the space's access record is never an event ----------------------
		// Check 13c wrote access/self into this same space, so the slice is shown
		// to leave out a record that is really there.
		const accessNow = await spaceRecord(groupToken, CALENDAR_SPACE_URI, ACCESS_COLLECTION, 'self');
		const sliced = [memberSlice, strangerSlice, anonymousSlice].flatMap(
			(s) => s.slice?.events ?? []
		);
		const notEvents = sliced.filter((e) => !String(e.uri).includes(`/${EVENT_COLLECTION}/`));
		record(
			accessNow.status === 200 && memberEvents.length >= 1 && notEvents.length === 0,
			'the members-only slice never holds the calendar space’s access record, though the space does',
			`access/self in the calendar space: ${accessNow.error ?? accessNow.status}; ` +
				`${sliced.length} record(s) across the three slices, ${notEvents.length} not an event` +
				`${notEvents.length ? `: ${notEvents.map((e) => e.uri).join(', ')}` : ''}`
		);

		// 13h. a sign-in that reads no spaces is told why, and nothing is read ----
		// The op signs the member in without the meta read grant, as a sign-in from
		// before it was asked for: nothing can be read with their access, and no one
		// reads as the group in their place (TS 2026-10-15).
		const blindSlice = await op('membersOnlySlice', { did: BOB, session: 'no-read' });
		record(
			blindSlice.reads === false &&
				blindSlice.onRoster === true &&
				JSON.stringify(blindSlice.slice?.events) === '[]' &&
				blindSlice.slice?.notice === NO_ACCESS_NOTICE &&
				blindSlice.calls.length === 0 &&
				blindSlice.groupCalls.length === 0,
			'the members-only slice of a member whose sign-in reads no spaces is empty, says why, and sends nothing',
			`reader ${blindSlice.reads}; ${BOB} on the roster ${blindSlice.onRoster} (from the row); ` +
				`notice "${blindSlice.slice?.notice}"; ${blindSlice.calls.length} request(s) with their access, ` +
				`${blindSlice.groupCalls.length} as the group`
		);

		// 13i-13p. members-only events, written by the app ---------------------------
		// The app's writer puts a members-only event in the calendar space and
		// nowhere else, keeps it there through an edit, refuses to move it, and
		// deletes it there. Every result is read back from the host, never taken from
		// what the writer returned: anonymously from the public repo and the space,
		// and as the group from the space. Each write op also comes back with every
		// request it sent through the group's session, so "nothing was written" is a
		// count. The owner acts throughout.
		const membersOnlyName = 'e2e members-only workshop';
		const membersOnlyAt = '2026-10-06T18:00:00.000Z';
		const membersOnlyRecord = eventRecord(membersOnlyName, { createdAt: membersOnlyAt });

		// 13i. it is written into the calendar space, and only there ---------------
		const moCreate = await tracedOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			placement: 'members',
			record: membersOnlyRecord
		});
		if (!moCreate.ok) {
			throw new Error(
				`the members-only create failed: ${moCreate.error.name}: ${moCreate.error.message}`
			);
		}
		const moRkey = moCreate.value.rkey;
		const moUri = `${CALENDAR_SPACE_URI}/${GROUP_DID}/${EVENT_COLLECTION}/${moRkey}`;
		const moRead = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, moRkey);
		const moAsWritten =
			JSON.stringify(canonical(moRead.value)) ===
			JSON.stringify(canonical({ ...membersOnlyRecord, $type: EVENT_COLLECTION }));
		const moInRepo = await getRecord(GROUP_DID, moRkey);
		const repoNow = await listRecords(GROUP_DID);
		const repoCopies = repoNow.records.filter(
			(r) => String(r.uri).endsWith(`/${moRkey}`) || r.value?.name === membersOnlyName
		);
		const anonymousListing = await anonymousSpaceList(CALENDAR_SPACE_URI);
		const createWrites = writesIn(moCreate.calls);
		record(
			moRead.status === 200 &&
				moRead.uri === moUri &&
				moAsWritten &&
				JSON.stringify(createWrites) === JSON.stringify(['com.atproto.space.createRecord']) &&
				notFound(moInRepo) &&
				repoNow.status === 200 &&
				repoCopies.length === 0 &&
				anonymousListing.status === 401 &&
				anonymousListing.error === 'AuthMissing',
			'a members-only event is written into the calendar space: anonymous repo reads miss it, an anonymous space listing is refused, and the group reads it back as written',
			`the group reads ${moRead.uri ?? moRead.error} (cid ${moRead.cid}), value ` +
				`${moAsWritten ? 'as written' : 'NOT as written'}; writes sent: [${createWrites.join(', ')}]; ` +
				`anonymous repo getRecord ${moInRepo.error ?? moInRepo.status}, listRecords ` +
				`${repoCopies.length} of ${repoNow.records.length} record(s) name it; anonymous space ` +
				`listRecords ${anonymousListing.status} ${anonymousListing.error ?? ''}`
		);

		// 13j. an edit stays in the space ------------------------------------------
		const moEditedName = `${membersOnlyName} (moved to the evening)`;
		const moEdit = await tracedOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'update',
			rkey: moRkey,
			placement: 'members',
			record: eventRecord(moEditedName, { createdAt: membersOnlyAt })
		});
		const moAfterEdit = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, moRkey);
		const moRepoAfterEdit = await getRecord(GROUP_DID, moRkey);
		const repoAfterEdit = await listRecords(GROUP_DID);
		const editWrites = writesIn(moEdit.calls);
		record(
			moEdit.ok === true &&
				moAfterEdit.status === 200 &&
				moAfterEdit.value?.name === moEditedName &&
				moAfterEdit.cid !== moRead.cid &&
				JSON.stringify(editWrites) === JSON.stringify(['com.atproto.space.putRecord']) &&
				notFound(moRepoAfterEdit) &&
				!repoAfterEdit.records.some(
					(r) => String(r.uri).endsWith(`/${moRkey}`) || r.value?.name === moEditedName
				),
			'a members-only event edit stays in the calendar space, and the public repo still misses it',
			`${moEdit.ok ? 'edited' : `REFUSED ${moEdit.error?.name}(${moEdit.error?.reason})`}; the space ` +
				`holds "${moAfterEdit.value?.name}" (cid ${moRead.cid} -> ${moAfterEdit.cid}); writes sent: ` +
				`[${editWrites.join(', ')}]; anonymous repo getRecord ${moRepoAfterEdit.error ?? moRepoAfterEdit.status}`
		);

		// 13k. a flip to public is refused ----------------------------------------
		// A put creates a record where none is, so without the refusal this edit
		// would publish a copy of the event under the same key.
		const flip = await tracedOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'update',
			rkey: moRkey,
			placement: 'everyone',
			record: eventRecord(`${membersOnlyName} (made public)`, { createdAt: membersOnlyAt })
		});
		const flipInRepo = await getRecord(GROUP_DID, moRkey);
		const flipInSpace = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, moRkey);
		const flipWrites = writesIn(flip.calls);
		record(
			flip.ok === false &&
				flip.error.name === 'GroupPlacementError' &&
				flip.error.reason === 'placement-change' &&
				flipWrites.length === 0 &&
				notFound(flipInRepo) &&
				flipInSpace.status === 200 &&
				flipInSpace.cid === moAfterEdit.cid,
			'a members-only event cannot be flipped to public: the edit is refused, and nothing appears in the public repo',
			`${flip.error?.name}(${flip.error?.reason}): ${flip.error?.message}; writes sent: ` +
				`[${flipWrites.join(', ')}]; anonymous repo getRecord ${flipInRepo.error ?? flipInRepo.status}; ` +
				`the space copy ${flipInSpace.cid === moAfterEdit.cid ? 'unchanged' : `CHANGED to ${flipInSpace.cid}`}`
		);

		// 13l. a public event is not made members-only by an edit either ---------
		const publicName = 'e2e public talk';
		const shown = await op('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			placement: 'everyone',
			record: eventRecord(publicName)
		});
		written.push(shown.rkey);
		const shownBefore = await getRecord(GROUP_DID, shown.rkey);
		const promote = await tracedOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'update',
			rkey: shown.rkey,
			placement: 'members',
			record: eventRecord(`${publicName} (members only)`)
		});
		const promotedInSpace = await spaceRecord(
			groupToken,
			CALENDAR_SPACE_URI,
			EVENT_COLLECTION,
			shown.rkey
		);
		const shownAfter = await getRecord(GROUP_DID, shown.rkey);
		const promoteWrites = writesIn(promote.calls);
		record(
			promote.ok === false &&
				promote.error.name === 'GroupPlacementError' &&
				promote.error.reason === 'placement-change' &&
				promoteWrites.length === 0 &&
				notFound(promotedInSpace) &&
				shownBefore.status === 200 &&
				shownAfter.cid === shownBefore.cid,
			'a members-only event cannot be made from a public one: the edit sent with the calendar space is refused, and no space record appears',
			`${promote.error?.name}(${promote.error?.reason}): ${promote.error?.message}; writes sent: ` +
				`[${promoteWrites.join(', ')}]; the space at ${shown.rkey}: ` +
				`${promotedInSpace.error ?? promotedInSpace.status}; the public record ` +
				`${shownAfter.cid === shownBefore.cid ? 'unchanged' : `CHANGED to ${shownAfter.cid}`}`
		);

		// 13m. no field says who may read it, in either container -----------------
		const moKeys = keysDeep(moAfterEdit.value);
		const shownKeys = keysDeep(shownBefore.value);
		const flagged = [...moKeys, ...shownKeys].filter((key) => AUDIENCE_KEYS.includes(key));
		const topKeys = (value) => JSON.stringify(Object.keys(value ?? {}).sort());
		record(
			moAfterEdit.status === 200 &&
				shownBefore.status === 200 &&
				flagged.length === 0 &&
				topKeys(moAfterEdit.value) === topKeys(shownBefore.value),
			'a members-only event carries no visibility, privacy or audience key, and has the same fields as a public one',
			`calendar space copy ${topKeys(moAfterEdit.value)}; public repo copy ` +
				`${topKeys(shownBefore.value)}; audience keys found: ${flagged.length ? flagged.join(', ') : 'none'}`
		);
		await op('deleteGroupEvent', {
			callerDid: ALICE,
			rkey: shown.rkey,
			placement: 'everyone'
		});

		// 13n. it is deleted from the space, and only from the space -------------
		// A delete of a missing record succeeds in either container, so one sent to
		// the public repo would report success and leave the event in place.
		const wrongDelete = await tracedOp('deleteGroupEvent', {
			callerDid: ALICE,
			rkey: moRkey,
			placement: 'everyone'
		});
		const afterWrongDelete = await spaceRecord(
			groupToken,
			CALENDAR_SPACE_URI,
			EVENT_COLLECTION,
			moRkey
		);
		const moDelete = await tracedOp('deleteGroupEvent', {
			callerDid: ALICE,
			rkey: moRkey,
			placement: 'members'
		});
		const moAfterDelete = await spaceRecord(
			groupToken,
			CALENDAR_SPACE_URI,
			EVENT_COLLECTION,
			moRkey
		);
		const ownerSlice = await op('membersOnlySlice', { did: ALICE });
		const stillListed = (ownerSlice.slice?.events ?? []).some((e) => e.rkey === moRkey);
		const deleteWrites = writesIn(moDelete.calls);
		record(
			wrongDelete.ok === false &&
				wrongDelete.error.name === 'GroupPlacementError' &&
				wrongDelete.error.reason === 'wrong-placement-delete' &&
				writesIn(wrongDelete.calls).length === 0 &&
				afterWrongDelete.status === 200 &&
				moDelete.ok === true &&
				JSON.stringify(deleteWrites) === JSON.stringify(['com.atproto.space.deleteRecord']) &&
				notFound(moAfterDelete) &&
				ownerSlice.slice?.notice === null &&
				!stillListed,
			'a members-only event is deleted from the calendar space: a delete sent to the public repo is refused, and after the real one the group no longer finds it',
			`public-repo delete: ${wrongDelete.error?.name}(${wrongDelete.error?.reason}), the event ` +
				`${afterWrongDelete.status === 200 ? 'still there' : `GONE (${afterWrongDelete.error})`}; ` +
				`calendar delete ${moDelete.ok ? 'done' : `REFUSED ${moDelete.error?.name}`}, writes sent: ` +
				`[${deleteWrites.join(', ')}]; the group's getRecord ${moAfterDelete.error ?? moAfterDelete.status}; ` +
				`the owner's slice lists it: ${stillListed}`
		);

		// 13o. a group without the space is refused, by the host's own answer ------
		// The writer refuses a members-only write when the host says the calendar
		// space does not exist. The check is run alone here on a calendar space
		// that was never created, through the app's own reader: it reads and
		// never writes, because a write would make the host create the space.
		const neverBefore = await spaceReadPolicy(groupToken, NEVER_CREATED_SPACE);
		const spaceProbe = await op('calendarSpaceCheck', {
			space: NEVER_CREATED_SPACE
		});
		const neverAfter = await spaceReadPolicy(groupToken, NEVER_CREATED_SPACE);
		record(
			neverBefore.status === 400 &&
				neverBefore.error === 'SpaceNotFound' &&
				spaceProbe.refusal?.name === 'GroupPlacementError' &&
				spaceProbe.refusal?.reason === 'no-calendar-space' &&
				spaceProbe.calls.length === 1 &&
				spaceProbe.calls[0].startsWith('/xrpc/com.atproto.simplespace.getSpace?') &&
				neverAfter.status === 400 &&
				neverAfter.error === 'SpaceNotFound',
			'a members-only event has nowhere to go in a group without a calendar space: the host answers SpaceNotFound through the app reader, and the app refuses',
			`getSpace before ${neverBefore.error ?? neverBefore.status}; the check: ` +
				`${spaceProbe.refusal ? `${spaceProbe.refusal.name}(${spaceProbe.refusal.reason})` : 'NO REFUSAL'} after ` +
				`${spaceProbe.calls.length} request(s) (${spaceProbe.calls.map((c) => c.split('?')[0]).join(', ')}); ` +
				`getSpace after ${neverAfter.error ?? neverAfter.status}`
		);

		// 13p. its image stays in the space ---------------------------------------
		// Uploaded as check 9's is, into the group's repo, then cited only from a
		// space record. The host serves a blob anonymously only while a public
		// record cites it, so anonymous getBlob must miss it while the group reads
		// it back through the space. The image is new each run, so no public record
		// cites the same bytes.
		const moImageBytes = runPng();
		const moImage = await op('uploadGroupEventImage', {
			callerDid: ALICE,
			intent: 'create',
			bytes: [...moImageBytes],
			mimeType: 'image/png'
		});
		const moWithImage = await tracedOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			placement: 'members',
			record: eventRecord(`${membersOnlyName}, with an image`, { image: moImage })
		});
		const moImageRead = moWithImage.ok
			? await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, moWithImage.value.rkey)
			: {};
		const moCited = moImageRead.value?.media?.[0]?.content?.ref?.$link;
		const imageAnonymous = await anonymousBlob(moImage?.ref?.$link);
		const imageAsGroup = await spaceBlob(groupToken, CALENDAR_SPACE_URI, moImage?.ref?.$link);
		const imageWrites = writesIn(moWithImage.calls);
		record(
			moWithImage.ok === true &&
				JSON.stringify(imageWrites) === JSON.stringify(['com.atproto.space.createRecord']) &&
				moImageRead.status === 200 &&
				moCited === moImage?.ref?.$link &&
				imageAnonymous.status === 400 &&
				imageAnonymous.error === 'BlobNotFound' &&
				imageAsGroup.status === 200 &&
				imageAsGroup.bytes?.equals(moImageBytes) === true,
			'a members-only event keeps its image in the calendar space: anonymous sync.getBlob answers BlobNotFound, and the group reads it back with space.getBlob',
			`${moImageRead.uri ?? moWithImage.error?.name} cites ${moCited}; uploaded ` +
				`${moImage?.ref?.$link}; writes sent: [${imageWrites.join(', ')}]; anonymous ` +
				`sync.getBlob ${imageAnonymous.status} ${imageAnonymous.error ?? ''}; the group's ` +
				`space.getBlob ${imageAsGroup.status}${imageAsGroup.bytes ? `, ${imageAsGroup.bytes.equals(moImageBytes) ? 'bytes match' : 'BYTES DIFFER'}` : ` ${imageAsGroup.error ?? ''}`}`
		);

		// 13q. a member's slice shows it without the image ------------------------
		// The card would build a cdn.bsky.app URL from the image, which hands a
		// third party the group's DID and the image's CID, so the members-only
		// read leaves it out until members get it through atmo's own route. The
		// event itself is read as written, and the stored record keeps its image.
		const imageRkey = moWithImage.ok ? moWithImage.value.rkey : null;
		const imageSlice = await op('membersOnlySlice', { did: BOB });
		const imageRead = (imageSlice.slice?.events ?? []).filter((e) => e.rkey === imageRkey);
		const imageValue = imageRead[0]?.value ?? {};
		record(
			imageRkey !== null &&
				imageSlice.onRoster === true &&
				imageSlice.slice?.notice === null &&
				imageRead.length === 1 &&
				imageRead[0].uri ===
					`${CALENDAR_SPACE_URI}/${GROUP_DID}/${EVENT_COLLECTION}/${imageRkey}` &&
				imageRead[0].space === CALENDAR_SPACE_URI &&
				imageValue.name === `${membersOnlyName}, with an image` &&
				!('media' in imageValue) &&
				moCited !== undefined &&
				moCited === moImage?.ref?.$link,
			"a members-only event reaches a member's slice without its image, and the stored record keeps it",
			`${BOB} on the roster ${imageSlice.onRoster}; notice ${imageSlice.slice?.notice}; ` +
				`${imageRead.length} event(s) at key ${imageRkey}, ${imageRead[0]?.uri} (space ` +
				`${imageRead[0]?.space}), named ${JSON.stringify(imageValue.name)}, media ` +
				`${'media' in imageValue ? `PRESENT (${JSON.stringify(imageValue.media)})` : 'absent'}; ` +
				`the stored record cites ${moCited}, uploaded ${moImage?.ref?.$link}`
		);
		// 13r. one members-only event, by its key -------------------------------
		// What the event's page reads: one event from the calendar space, as the
		// group, by its key. A member gets it whole, image included, since the edit
		// page saves what it loads and only the page drops the image, for display.
		// A non-member and an anonymous visitor are refused before the read, so the
		// requests the event read alone sent are counted, and must be none. A key
		// the space does not hold is absent, after one read. Run before the image
		// event 13p wrote is deleted, so the image is really there to keep.
		const moKey = imageRkey ?? SEED_RKEY;
		const oneForMember = await op('membersOnlyEvent', {
			did: BOB,
			rkey: moKey
		});
		const oneForStranger = await op('membersOnlyEvent', {
			did: MALLORY,
			rkey: moKey
		});
		const oneForAnonymous = await op('membersOnlyEvent', {
			did: null,
			rkey: moKey
		});
		const oneMadeUp = await op('membersOnlyEvent', {
			did: BOB,
			rkey: MADE_UP_RKEY
		});
		const oneEvent = oneForMember.read?.status === 'found' ? oneForMember.read.event : null;
		const oneImage = oneEvent?.value?.media?.[0]?.content?.ref?.$link;
		const oneGets = (op) =>
			calendarCalls(op.readCalls).filter((path) =>
				path.startsWith('/xrpc/com.atproto.space.getRecord?')
			);
		const refusedUnread = (op) =>
			op.onRoster === false &&
			op.read?.status === 'hidden' &&
			op.readCalls.length === 0 &&
			calendarCalls(op.calls).length === 0;
		record(
			imageRkey !== null &&
				oneForMember.onRoster === true &&
				oneEvent !== null &&
				oneEvent.uri === `${CALENDAR_SPACE_URI}/${GROUP_DID}/${EVENT_COLLECTION}/${imageRkey}` &&
				oneEvent.rkey === imageRkey &&
				oneEvent.space === CALENDAR_SPACE_URI &&
				oneEvent.cid === moImageRead.cid &&
				oneEvent.value?.name === `${membersOnlyName}, with an image` &&
				oneImage !== undefined &&
				oneImage === moImage?.ref?.$link &&
				reads(oneForMember.readCalls).length === 1 &&
				oneGets(oneForMember).length === 1 &&
				oneForMember.groupCalls.length === 0 &&
				refusedUnread(oneForStranger) &&
				refusedUnread(oneForAnonymous) &&
				oneMadeUp.onRoster === true &&
				oneMadeUp.read?.status === 'absent' &&
				reads(oneMadeUp.readCalls).length === 1 &&
				oneGets(oneMadeUp).length === 1,
			'one members-only event is read by its rkey for a member, image kept, and a non-member and an anonymous caller send no read',
			`${BOB}: ${oneForMember.read?.status} at ${oneEvent?.uri} (space ${oneEvent?.space}; cid ` +
				`${oneEvent?.cid === moImageRead.cid ? 'as the PDS has it' : `${oneEvent?.cid}, the PDS has ${moImageRead.cid}`}), ` +
				`image ${oneImage === undefined ? 'MISSING' : oneImage === moImage?.ref?.$link ? 'kept' : `${oneImage}, uploaded ${moImage?.ref?.$link}`}, ` +
				`${reads(oneForMember.readCalls).length} read(s) with their own access, ${oneGets(oneForMember).length} a calendar getRecord, ` +
				`${oneForMember.groupCalls.length} as the group; ` +
				`${MALLORY}: ${oneForStranger.read?.status}, ${oneForStranger.readCalls.length} request(s) for the read, ` +
				`${calendarCalls(oneForStranger.calls).length} to the calendar space of ${oneForStranger.calls.length}; ` +
				`anonymous: ${oneForAnonymous.read?.status}, ${oneForAnonymous.readCalls.length} request(s) for the read, ` +
				`${calendarCalls(oneForAnonymous.calls).length} to the calendar space of ${oneForAnonymous.calls.length}; ` +
				`${BOB} at ${MADE_UP_RKEY}: ${oneMadeUp.read?.status} after ${reads(oneMadeUp.readCalls).length} read(s)`
		);
		// 13s. the edit page's read, saved back ----------------------------------
		// What the edit page reads for a manager: the same event, whole, as the
		// editor gets it, with no key naming the space, since the editor writes back
		// what it loads. Saved back as the editor saves it (without the cid, DID,
		// key and URI the read puts beside the record, and renamed), it stays in the
		// space with its image and gains no field. A roster member who may not edit,
		// a non-member and an anonymous caller are refused by the editor gate with
		// nothing sent past their standing. BOB is an admin by now, so he is a plain
		// member for his refusal and promoted back after it, as check 17 does. Run
		// before the image event 13p wrote is deleted.
		const editRead = await op('membersOnlyEditRead', {
			did: ALICE,
			rkey: moKey
		});
		const editCopy = editRead.eventData;
		const editImage = editCopy?.media?.[0]?.content?.ref?.$link;
		const renamedWithImage = `${membersOnlyName}, with an image (renamed)`;
		let editSave = { ok: false, calls: [] };
		if (editCopy) {
			// The editor's own save drops these, which the read puts beside the record.
			const kept = { ...editCopy };
			for (const key of ['cid', 'did', 'rkey', 'uri']) delete kept[key];
			editSave = await tracedOp('writeGroupEvent', {
				callerDid: ALICE,
				intent: 'update',
				rkey: moKey,
				placement: 'members',
				record: { ...kept, name: renamedWithImage }
			});
		}
		const editAfter = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, moKey);
		const editAfterValue = editAfter.value ?? {};
		const keysBefore = Object.keys(moImageRead.value ?? {})
			.sort()
			.join(', ');
		const keysAfter = Object.keys(editAfterValue).sort().join(', ');
		const editSaveWrites = writesIn(editSave.calls);
		const editBlobAnonymous = await anonymousBlob(moImage?.ref?.$link);
		const editInRepo = await getRecord(GROUP_DID, moKey);
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'member' });
		let editForMember;
		try {
			editForMember = await op('membersOnlyEditRead', {
				did: BOB,
				rkey: moKey
			});
		} finally {
			await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
		}
		const editForStranger = await op('membersOnlyEditRead', {
			did: MALLORY,
			rkey: moKey
		});
		const editForAnonymous = await op('membersOnlyEditRead', {
			did: null,
			rkey: moKey
		});
		const refusedByGate = (op, onRoster) =>
			op.allowed === false &&
			op.onRoster === onRoster &&
			op.read === null &&
			op.readCalls.length === 0 &&
			calendarCalls(op.calls).length === 0;
		const refusalDetail = (who, op) =>
			`${who}: ${op.allowed ? 'ALLOWED' : 'refused'} (on the roster ${op.onRoster}), ` +
			`${op.readCalls.length} request(s) past standing, ${calendarCalls(op.calls).length} to the calendar space`;
		record(
			imageRkey !== null &&
				editRead.allowed === true &&
				editRead.read?.status === 'found' &&
				editCopy !== null &&
				!('space' in editCopy) &&
				editCopy.uri === `${CALENDAR_SPACE_URI}/${GROUP_DID}/${EVENT_COLLECTION}/${imageRkey}` &&
				editImage === moImage?.ref?.$link &&
				editRead.readCalls.length === 1 &&
				editSave.ok === true &&
				JSON.stringify(editSaveWrites) === JSON.stringify(['com.atproto.space.putRecord']) &&
				editAfter.status === 200 &&
				editAfterValue.name === renamedWithImage &&
				editAfter.cid !== moImageRead.cid &&
				editAfterValue.media?.[0]?.content?.ref?.$link === moImage?.ref?.$link &&
				keysAfter === keysBefore &&
				!('space' in editAfterValue) &&
				editBlobAnonymous.status === 400 &&
				editBlobAnonymous.error === 'BlobNotFound' &&
				notFound(editInRepo) &&
				refusedByGate(editForMember, true) &&
				refusedByGate(editForStranger, false) &&
				refusedByGate(editForAnonymous, false),
			"a manager's edit read of a members-only event keeps its image, and saving it back keeps the image in the space with no field added",
			`${ALICE}: ${editRead.read?.status} after ${editRead.readCalls.length} request(s), image ` +
				`${editImage === undefined ? 'MISSING' : editImage === moImage?.ref?.$link ? 'kept' : editImage}, ` +
				`space key on the edit copy ${editCopy && 'space' in editCopy ? 'PRESENT' : 'absent'}; ` +
				`saved: ${editSave.ok ? 'ok' : `REFUSED ${editSave.error?.name}(${editSave.error?.reason})`}, ` +
				`writes sent: [${editSaveWrites.join(', ')}]; the space holds "${editAfterValue.name}" ` +
				`(cid ${moImageRead.cid} -> ${editAfter.cid}), image ` +
				`${editAfterValue.media?.[0]?.content?.ref?.$link === moImage?.ref?.$link ? 'kept' : 'CHANGED'}, ` +
				`keys ${keysAfter === keysBefore ? 'as before' : `[${keysAfter}], were [${keysBefore}]`}; ` +
				`anonymous sync.getBlob ${editBlobAnonymous.status} ${editBlobAnonymous.error ?? ''}, ` +
				`anonymous repo getRecord ${editInRepo.error ?? editInRepo.status}; ` +
				`${refusalDetail(`${BOB} as a plain member`, editForMember)}; ` +
				`${refusalDetail(MALLORY, editForStranger)}; ${refusalDetail('anonymous', editForAnonymous)}`
		);
		if (moWithImage.ok) {
			await op('deleteGroupEvent', {
				callerDid: ALICE,
				rkey: moWithImage.value.rkey,
				placement: 'members'
			});
		}

		// 13t. a member's RSVP to a members-only event ---------------------------
		// What the event page's RSVP button and its read-back run, through the module
		// the RSVP commands call: the admin, a roster member, RSVPs going to the seed
		// from their own session. That session is the password stand-in, whose scope
		// is the app's member grant, so the PDS's check of a real OAuth grant is not
		// shown here. The RSVP lands in the admin's repo in the calendar space at the
		// seed's key, naming the seed's space-form URI. The admin reads it back, and
		// so does the group, with its space credential at the admin's PDS. Nothing is
		// in the admin's public repo, and nothing the session sent names
		// com.atproto.repo. A cancel deletes it, and both reads then find nothing.
		// The page sends the cid of the version it showed, here the seed's as the
		// group reads it now.
		const seedNow = await spaceRecord(groupToken, CALENDAR_SPACE_URI, EVENT_COLLECTION, SEED_RKEY);
		const rsvpOp = (action, extra = {}) =>
			op('membersOnlyRsvp', {
				did: BOB,
				rkey: SEED_RKEY,
				action,
				asked: null,
				reauthorizeUrl: REAUTHORIZE_STAND_IN,
				...extra
			});
		const nsidsOf = (op) => op.calls.map((path) => path.split('?')[0].replace(/^\/xrpc\//, ''));
		rsvpWritten = true;
		const rsvpGoing = await rsvpOp('put', { status: 'going', cid: seedNow.cid });
		const rsvpOwn = await rsvpOp('read');
		const rsvpAsGroup = await op('calendarReadAt', {
			did: BOB,
			rkey: SEED_RKEY
		});
		const rsvpInRepo = await getRecord(BOB, SEED_RKEY, RSVP_COLLECTION);
		const rsvpCancel = await rsvpOp('delete');
		if (rsvpCancel.result?.ok === true) rsvpWritten = false;
		const ownAfterCancel = await rsvpOp('read');
		const groupAfterCancel = await op('calendarReadAt', {
			did: BOB,
			rkey: SEED_RKEY
		});
		const rsvpOps = [rsvpGoing, rsvpOwn, rsvpCancel, ownAfterCancel];
		const repoCalls = rsvpOps
			.flatMap(nsidsOf)
			.filter((nsid) => nsid.startsWith('com.atproto.repo.'));
		const rsvpUri = `${CALENDAR_SPACE_URI}/${BOB}/${RSVP_COLLECTION}/${SEED_RKEY}`;
		record(
			rsvpGoing.onRoster === true &&
				rsvpGoing.result?.ok === true &&
				rsvpGoing.result.uri === rsvpUri &&
				JSON.stringify(nsidsOf(rsvpGoing)) === JSON.stringify(['com.atproto.space.putRecord']) &&
				rsvpOwn.result?.status === 'going' &&
				rsvpOwn.result?.rkey === SEED_RKEY &&
				JSON.stringify(nsidsOf(rsvpOwn)) === JSON.stringify(['com.atproto.space.getRecord']) &&
				rsvpAsGroup.status === 200 &&
				rsvpAsGroup.uri === rsvpUri &&
				rsvpAsGroup.value?.subject?.uri === SEED_URI &&
				rsvpAsGroup.value?.status === `${RSVP_COLLECTION}#going` &&
				notFound(rsvpInRepo) &&
				rsvpCancel.result?.ok === true &&
				JSON.stringify(nsidsOf(rsvpCancel)) ===
					JSON.stringify(['com.atproto.space.deleteRecord']) &&
				ownAfterCancel.result === null &&
				notFound(groupAfterCancel) &&
				repoCalls.length === 0 &&
				rsvpOps.every((op) => op.reauthorized === 0),
			"a member's RSVP to a members-only event is written into the calendar space at the event's key from their own session, reads back for them and for the group, and a cancel removes it, with no repo call",
			`${BOB} on the roster ${rsvpGoing.onRoster}: put ${rsvpGoing.result?.ok ? `at ${rsvpGoing.result.uri}` : JSON.stringify(rsvpGoing.result)} ` +
				`sending [${nsidsOf(rsvpGoing).join(', ')}]; their read ${JSON.stringify(rsvpOwn.result)} ` +
				`sending [${nsidsOf(rsvpOwn).join(', ')}]; the group's read at ${rsvpAsGroup.host} ` +
				`${rsvpAsGroup.status}${rsvpAsGroup.error ? ` ${rsvpAsGroup.error}` : ''}, ${rsvpAsGroup.value?.status} ` +
				`naming ${rsvpAsGroup.value?.subject?.uri === SEED_URI ? "the seed's space-form URI" : rsvpAsGroup.value?.subject?.uri}; ` +
				`public repo getRecord ${rsvpInRepo.error ?? rsvpInRepo.status}; cancel ` +
				`${rsvpCancel.result?.ok ? 'ok' : JSON.stringify(rsvpCancel.result)} sending [${nsidsOf(rsvpCancel).join(', ')}]; ` +
				`after it their read ${JSON.stringify(ownAfterCancel.result)}, the group's ` +
				`${groupAfterCancel.error ?? groupAfterCancel.status}; com.atproto.repo calls ${repoCalls.length}`
		);

		// 13u. who sends no RSVP request -----------------------------------------
		// The roster gate comes before the grant: a non-member, whose stand-in
		// session holds the grant and refuses any request, is turned away with
		// nothing sent and no re-authorization. A member whose PDS serves no spaces
		// holds no grant. Their first RSVP is sent to re-authorize (a stand-in URL,
		// never followed) with a marker for the page to carry, and only once the page
		// hands that marker back under a session issued since (a new stamp) are they
		// told their PDS can't do it. Neither sends a request through their session. They are admitted for this check and leave right
		// after, off the rows, the records and both member lists, so 18e's join
		// still comes back pending.
		const outsiderOp = (action, extra = {}) =>
			op('membersOnlyRsvp', {
				did: MALLORY,
				rkey: SEED_RKEY,
				action,
				asked: null,
				session: 'outsider',
				reauthorizeUrl: REAUTHORIZE_STAND_IN,
				...extra
			});
		const outsiderPut = await outsiderOp('put', { status: 'going' });
		const outsiderCancel = await outsiderOp('delete');
		const outsiderRead = await outsiderOp('read');
		const noSpacesBefore = await must('noSpacesCalls');
		await op('admitMember', { callerDid: ALICE, did: CAROL, role: 'member' });
		const carolOp = (asked, stamp) =>
			op('membersOnlyRsvp', {
				did: CAROL,
				rkey: SEED_RKEY,
				action: 'put',
				status: 'going',
				cid: seedNow.cid,
				asked,
				stamp,
				session: 'no-spaces',
				reauthorizeUrl: REAUTHORIZE_STAND_IN
			});
		const carolFirst = await carolOp(null, 1);
		const carolAfterAsking = await carolOp(carolFirst.result?.marker ?? null, 2);
		const noSpacesAfter = await must('noSpacesCalls');
		await op('leaveGroup', {
			callerDid: CAROL,
			asMember: true,
			session: 'no-spaces'
		});
		const carolRecords = await op('recordedRoster');
		const carolRows = await op('listMembers');
		const carolLists = await Promise.all(
			[membersSpaceUri, aboutSpaceUri, calendarSpaceUri].map((space) =>
				spaceMemberList(groupToken, space)
			)
		);
		const carolLeft =
			!carolRecords.memberships.some((m) => m.subject === CAROL) &&
			!carolRows.some((m) => m.did === CAROL) &&
			carolLists.every((list) => list.status === 200 && !list.members.some((m) => m.did === CAROL));
		const outsiderOps = [outsiderPut, outsiderCancel, outsiderRead];
		record(
			outsiderOps.every(
				(op) => op.onRoster === false && op.calls.length === 0 && op.reauthorized === 0
			) &&
				outsiderPut.result?.ok === false &&
				outsiderPut.result.reason === 'not-member' &&
				outsiderCancel.result?.ok === false &&
				outsiderCancel.result.reason === 'not-member' &&
				outsiderRead.result === null &&
				carolFirst.onRoster === true &&
				carolFirst.result?.reason === 'reauthorize' &&
				carolFirst.result.url === REAUTHORIZE_STAND_IN &&
				typeof carolFirst.result.marker === 'string' &&
				carolFirst.reauthorized === 1 &&
				carolFirst.calls.length === 0 &&
				carolAfterAsking.onRoster === true &&
				carolAfterAsking.result?.reason === 'no-spaces' &&
				carolAfterAsking.result.message === RSVP_NO_SPACES &&
				carolAfterAsking.reauthorized === 0 &&
				carolAfterAsking.calls.length === 0 &&
				noSpacesAfter.length === noSpacesBefore.length &&
				carolLeft,
			'a caller off the roster and a member whose PDS serves no spaces send no RSVP request, and only the member asked before gets the no-spaces message',
			`${MALLORY}: put ${outsiderPut.result?.reason}, cancel ${outsiderCancel.result?.reason}, read ` +
				`${JSON.stringify(outsiderRead.result)}, ${outsiderOps.reduce((n, op) => n + op.calls.length, 0)} request(s), ` +
				`${outsiderOps.reduce((n, op) => n + op.reauthorized, 0)} re-authorization(s); ${CAROL} on the roster ` +
				`${carolFirst.onRoster}: first ${carolFirst.result?.reason} (${carolFirst.reauthorized} re-authorization, ` +
				`${carolFirst.calls.length} request(s)), after asking ${carolAfterAsking.result?.reason} ` +
				`${JSON.stringify(carolAfterAsking.result?.message)} (${carolAfterAsking.reauthorized} re-authorization, ` +
				`${carolAfterAsking.calls.length} request(s)); sent from their session ${noSpacesAfter.length - noSpacesBefore.length}; ` +
				`after leaving: ${carolLeft ? 'off the records, the rows and both member lists' : 'STILL LISTED'}`
		);

		// 13v. the version of the event an RSVP names -----------------------------
		// An RSVP's subject names the event's cid as well as its URI. The module
		// reads the seed as the group just before the write, so the admin's RSVP,
		// as the group reads it back, cites the cid the group reads for the seed.
		// An RSVP from a page that showed another version (any other cid) answers
		// 'changed', and the admin's session sends nothing for it: the RSVP already
		// there keeps its answer and its cid. A cancel after leaves nothing behind.
		const staleCid = 'bafyreie2estaleversionofthemembersonlyseedevent';
		rsvpWritten = true;
		const cidGoing = await rsvpOp('put', { status: 'going', cid: seedNow.cid });
		const cidAsGroup = await op('calendarReadAt', {
			did: BOB,
			rkey: SEED_RKEY
		});
		const cidStale = await rsvpOp('put', { status: 'notgoing', cid: staleCid });
		const cidAfterStale = await op('calendarReadAt', {
			did: BOB,
			rkey: SEED_RKEY
		});
		const cidCancel = await rsvpOp('delete');
		if (cidCancel.result?.ok === true) rsvpWritten = false;
		const cidGone = await op('calendarReadAt', {
			did: BOB,
			rkey: SEED_RKEY
		});
		record(
			seedNow.status === 200 &&
				typeof seedNow.cid === 'string' &&
				seedNow.cid.length > 0 &&
				seedNow.cid !== staleCid &&
				cidGoing.result?.ok === true &&
				JSON.stringify(nsidsOf(cidGoing)) === JSON.stringify(['com.atproto.space.putRecord']) &&
				cidAsGroup.status === 200 &&
				cidAsGroup.value?.subject?.uri === SEED_URI &&
				cidAsGroup.value?.subject?.cid === seedNow.cid &&
				cidStale.result?.ok === false &&
				cidStale.result.reason === 'changed' &&
				cidStale.calls.length === 0 &&
				cidStale.reauthorized === 0 &&
				cidAfterStale.status === 200 &&
				cidAfterStale.value?.status === `${RSVP_COLLECTION}#going` &&
				cidAfterStale.value?.subject?.cid === seedNow.cid &&
				cidCancel.result?.ok === true &&
				notFound(cidGone),
			"a members-only RSVP names the event's current cid as the group reads it, and one sent from a page showing an older version writes nothing",
			`the seed's cid as the group reads it ${seedNow.cid ?? `MISSING (${seedNow.error ?? seedNow.status})`}; ` +
				`put ${cidGoing.result?.ok ? 'ok' : JSON.stringify(cidGoing.result)} sending [${nsidsOf(cidGoing).join(', ')}]; ` +
				`the group's read ${cidAsGroup.status}${cidAsGroup.error ? ` ${cidAsGroup.error}` : ''} citing ` +
				`${cidAsGroup.value?.subject?.cid === seedNow.cid ? "the seed's cid" : JSON.stringify(cidAsGroup.value?.subject)}; ` +
				`a put naming another version ${cidStale.result?.reason ?? JSON.stringify(cidStale.result)} sending ` +
				`[${nsidsOf(cidStale).join(', ')}], after it the group reads ${cidAfterStale.value?.status} citing ` +
				`${cidAfterStale.value?.subject?.cid === seedNow.cid ? "the seed's cid" : JSON.stringify(cidAfterStale.value?.subject)}; ` +
				`cancel ${cidCancel.result?.ok ? 'ok' : JSON.stringify(cidCancel.result)}, then the group's read ` +
				`${cidGone.error ?? cidGone.status}`
		);

		// 14. the space's own member list holds the members, read and write -------
		// Reading a space and writing your own records in it are one grant, and
		// every role reads the members space, so the owner and an admitted member
		// are each read:true write:true. The PDS tracks the acceptance each writes.
		// (Spec: FR-206.)
		const memberList = await spaceMemberList(groupToken, membersSpaceUri);
		const readWrite = memberList.members.every((m) => m.read === true && m.write === true);
		record(
			memberList.status === 200 &&
				readWrite &&
				JSON.stringify(memberList.members.map((m) => m.did).sort()) ===
					JSON.stringify([ALICE, BOB].sort()),
			'the owner and an admitted member are on the members space’s own member list, read and write',
			`listMembers ${memberList.status}: ` +
				`${memberList.members.map((m) => `${m.did} read:${m.read} write:${m.write}`).join('; ') || 'empty'}` +
				`${memberList.error ? ` (${memberList.error})` : ''}`
		);

		// 15. the authz config is records ------------------------------------------
		// Read through the app's reader, which maps actions to our permission names,
		// and straight from the PDS, which shows the wire form uses the standard's
		// action identifiers. A role's grant is the union of both binding records.
		await op('writeGroupAuthz', { callerDid: ALICE });
		const authz = await op('recordedAuthz', { role: 'admin' });
		const permissionsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.permissions',
			'self'
		);
		const eventPermissionsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'rsvp.atmo.group.eventPermissions',
			'self'
		);
		const adminRoleRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.role',
			'admin'
		);
		const memberRoleRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.role',
			'member'
		);
		// The standard's shape: `grants` of role, scopes and what the role may
		// assign. The scopes themselves are checked by what they resolve to.
		const adminGrant = (permissionsRecord.value?.grants ?? []).find(
			(grant) => grant.role === 'admin'
		);
		const modalityActions = (eventPermissionsRecord.value?.bindings ?? []).find(
			(binding) => binding.role === 'admin'
		)?.actions;
		record(
			authz.hasAuthz === true &&
				authz.roles.join(',') === 'owner,admin,member' &&
				adminRoleRecord.status === 200 &&
				adminRoleRecord.value?.displayName === 'Admin' &&
				memberRoleRecord.value?.default === true &&
				!('roles' in (permissionsRecord.value ?? {})) &&
				Array.isArray(adminGrant?.scopes) &&
				adminGrant.scopes.length > 0 &&
				// No admin may assign or eject the owner.
				JSON.stringify(adminGrant?.assignable) === JSON.stringify(['admin', 'member']) &&
				JSON.stringify(modalityActions) === JSON.stringify(['manageEvents', 'createEvent']) &&
				authz.effective.permissions.join(',') ===
					'ADMIT_MEMBERS,ASSIGN_ROLES,CREATE_EVENT,EJECT_MEMBERS,MANAGE_EVENTS,MANAGE_GROUP',
			'roles and both permission records are in the members space, and a grant is their union',
			`roles [${authz.roles.join(', ')}] (member default ${memberRoleRecord.value?.default}); ` +
				`admin's scopes ${JSON.stringify(adminGrant?.scopes)} assigning ${JSON.stringify(adminGrant?.assignable)}; ` +
				`eventPermissions ${JSON.stringify(modalityActions)}; ` +
				`admin resolves to ${authz.effective.permissions.length} permission(s)`
		);

		// 15b. the gate follows the records ----------------------------------------
		// Take CREATE_EVENT from admin in the `eventPermissions` record only. The D1
		// rows still grant it, so only a gate that reads the records changes its answer.
		const probe = ['CREATE_EVENT', 'MANAGE_EVENTS'];
		const bobBefore = await op('membership', { did: BOB, probe });
		await op('writeGroupAuthz', {
			callerDid: ALICE,
			bundles: {
				owner: [
					'MANAGE_GROUP',
					'ADMIT_MEMBERS',
					'EJECT_MEMBERS',
					'ASSIGN_ROLES',
					'MANAGE_EVENTS',
					'CREATE_EVENT'
				],
				admin: ['MANAGE_GROUP', 'ADMIT_MEMBERS', 'EJECT_MEMBERS', 'ASSIGN_ROLES', 'MANAGE_EVENTS'],
				member: []
			}
		});
		const bobEdited = await op('membership', { did: BOB, probe });
		const editedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'rsvp.atmo.group.eventPermissions',
			'self'
		);
		await op('writeGroupAuthz', { callerDid: ALICE });
		const bobRestored = await op('membership', { did: BOB, probe });
		const bobRowRole = (await op('listMembers')).find((m) => m.did === BOB)?.role;
		record(
			bobBefore.can.CREATE_EVENT === true &&
				bobEdited.can.CREATE_EVENT === false &&
				bobEdited.can.MANAGE_EVENTS === true &&
				bobRowRole === 'admin' &&
				JSON.stringify(
					(editedRecord.value?.bindings ?? []).find((b) => b.role === 'admin')?.actions
				) === JSON.stringify(['manageEvents']) &&
				bobRestored.can.CREATE_EVENT === true,
			'editing a binding record changes the next gate decision, with no D1 write',
			`CREATE_EVENT for ${BOB}: before ${bobBefore.can.CREATE_EVENT}, after the live edit ` +
				`${bobEdited.can.CREATE_EVENT} (MANAGE_EVENTS ${bobEdited.can.MANAGE_EVENTS}), after restore ` +
				`${bobRestored.can.CREATE_EVENT}; his D1 row stayed ${bobRowRole}`
		);

		// 16. drop the roster rows, rebuild from records ---------------------------
		// A trigger protects the owner's row, so only the other rows are dropped.
		const dropped = await op('dropMembershipRows');
		const rosterWhileDropped = await op('recordedRoster', { did: BOB });
		const rebuiltMembers = await op('rebuildGroupMembers');
		record(
			dropped.dropped === 1 &&
				rosterWhileDropped.roster.length === 2 &&
				rebuiltMembers.restored.join(',') === BOB &&
				rebuiltMembers.orphans.length === 0 &&
				rebuiltMembers.skipped.length === 0 &&
				rebuiltMembers.roster.map((entry) => `${entry.did}/${entry.role}`).join(' ') ===
					`${ALICE}/owner ${BOB}/admin`,
			'the roster survives dropping its D1 rows: records render it, and rebuild restores them',
			`dropped ${dropped.dropped} row(s); roster from records while dropped ` +
				`${rosterWhileDropped.roster.length}; rebuilt ${rebuiltMembers.restored.length} ` +
				`(unchanged ${rebuiltMembers.unchanged.length}, orphans ${rebuiltMembers.orphans.length})`
		);

		// 17. a demotion is a revocation, and the record says so ------------------
		// A demotion writes the smaller record before the row (see roster.test.ts).
		// Only a live run shows that the PDS returns the smaller record, that the gate
		// follows it, and that the join date is kept. Promoting back leaves check 18
		// an admin to eject.
		const joinedAt = recorded.memberships.find((m) => m.subject === BOB)?.createdAt;
		const rosterProbe = ['EJECT_MEMBERS', 'CREATE_EVENT'];
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const demotedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.membership',
			BOB
		);
		const demoted = await op('membership', { did: BOB, probe: rosterProbe });
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
		const repromoted = await op('membership', {
			did: BOB,
			probe: rosterProbe
		});
		record(
			demotedRecord.status === 200 &&
				JSON.stringify(demotedRecord.value?.roles) === JSON.stringify(['member']) &&
				demotedRecord.value?.createdAt === joinedAt &&
				demoted.role === 'member' &&
				demoted.permissions.length === 0 &&
				demoted.can.EJECT_MEMBERS === false &&
				demoted.can.CREATE_EVENT === false &&
				repromoted.role === 'admin' &&
				repromoted.can.EJECT_MEMBERS === true,
			'a demotion rewrites the membership record to the smaller role and the gate follows it; promoting back restores it',
			`demoted: record roles ${JSON.stringify(demotedRecord.value?.roles)} ` +
				`(${demotedRecord.error ?? demotedRecord.status}), joined ${demotedRecord.value?.createdAt} ` +
				`(was ${joinedAt}), grants [${demoted.permissions.join(', ')}]; re-promoted: ${repromoted.role}, ` +
				`EJECT ${repromoted.can.EJECT_MEMBERS}`
		);

		// 18. no record, no access --------------------------------------------------
		// An eject deletes the record. Records, not rows, decide access.
		await op('ejectMember', { callerDid: ALICE, did: BOB });
		const afterEject = await op('recordedRoster', { did: BOB });
		const strangerCheck = await op('recordedRoster', { did: MALLORY });
		const ejectedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'group.opensocial.membership',
			BOB
		);
		const listAfterEject = await spaceMemberList(groupToken, membersSpaceUri);
		record(
			notFound(ejectedRecord) &&
				afterEject.hasAccess === false &&
				strangerCheck.hasAccess === false &&
				afterEject.roster.map((entry) => entry.did).join(',') === ALICE &&
				listAfterEject.status === 200 &&
				!listAfterEject.members.some((m) => m.did === BOB),
			'a DID with no membership record has no access, whether ejected or never a member',
			`${BOB} after eject: record ${ejectedRecord.error ?? ejectedRecord.status}, access ` +
				`${afterEject.hasAccess}, on the members space list ` +
				`${listAfterEject.members.some((m) => m.did === BOB)}; never-a-member ${MALLORY}: access ` +
				`${strangerCheck.hasAccess}; roster ${afterEject.roster.length}`
		);

		// 18b. a join request writes nothing; approval lists them; sign-in confirms --
		// A requester is not a member, so the request writes no acceptance and puts
		// them on no list, and the PDS refuses them a members space credential.
		// Approval lists them read and write, so the same request is granted. The
		// member's own half, the acceptance, is written from their own session at
		// their next sign-in, and the roster, which reads acceptances by DID with
		// the group's credential, then shows them confirmed. (Spec: FR-205,
		// FR-206, SC-202.)
		acceptanceWritten = true;
		const asked = await op('joinGroup', {
			callerDid: BOB,
			asMember: true,
			message: 'back again'
		});
		const atRequest = await ownAcceptance(bobToken, membersSpaceUri);
		const listAtRequest = await spaceMemberList(groupToken, membersSpaceUri);
		const credentialAtRequest = await spaceCredentialRequest(bobToken, membersSpaceUri);
		const pendingAgain = await op('listJoinRequests');
		const bobsRequest = pendingAgain.find((request) => request.did === BOB);
		await op('approveJoinRequest', {
			callerDid: ALICE,
			member: BOB,
			role: 'member'
		});
		const listApproved = await spaceMemberList(groupToken, membersSpaceUri);
		const credentialApproved = await spaceCredentialRequest(bobToken, membersSpaceUri);
		const bobApproved = (await op('confirmedRoster')).roster.find((entry) => entry.did === BOB);
		await op('signInAcceptances', { did: BOB });
		const afterApprovalSignIn = await ownAcceptance(bobToken, membersSpaceUri);
		const bobConfirmed = (await op('confirmedRoster')).roster.find((entry) => entry.did === BOB);
		record(
			asked.outcome === 'pending' &&
				bobsRequest !== undefined &&
				notFound(atRequest) &&
				listAtRequest.status === 200 &&
				!listAtRequest.members.some((m) => m.did === BOB) &&
				credentialAtRequest.stage === 'getSpaceCredential' &&
				credentialAtRequest.status === 400 &&
				credentialAtRequest.error === 'UserNotAuthorized' &&
				!credentialAtRequest.issued &&
				listApproved.members.some((m) => m.did === BOB && m.read === true && m.write === true) &&
				credentialApproved.status === 200 &&
				credentialApproved.issued &&
				bobApproved?.confirmed === false &&
				afterApprovalSignIn.status === 200 &&
				bobConfirmed?.confirmed === true,
			'a join request writes nothing and is refused a members space credential; approval lists them read and write and the credential is issued; their sign-in confirms them',
			`request ${asked.outcome}, listed by the host ${bobsRequest !== undefined}; ` +
				`acceptance at request ${atRequest.error ?? atRequest.status}; ` +
				`on the members list at request ${listAtRequest.members.some((m) => m.did === BOB)}; ` +
				`credential at request ${JSON.stringify(credentialAtRequest)}; approved entry ` +
				`${JSON.stringify(listApproved.members.find((m) => m.did === BOB) ?? null)}, credential ` +
				`${JSON.stringify(credentialApproved)}, confirmed ${bobApproved?.confirmed}; after sign-in ` +
				`acceptance ${afterApprovalSignIn.error ?? afterApprovalSignIn.status}, confirmed ${bobConfirmed?.confirmed}`
		);

		// 18c. leaving deletes it ---------------------------------------------------
		// From the member's session, before the group takes them off the members
		// list, so the host still accepts the notice of the delete.
		const beforeLeaving = await ownAcceptance(bobToken, membersSpaceUri);
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		const afterLeaving = await ownAcceptance(bobToken, membersSpaceUri);
		const rosterAfterLeaving = await op('confirmedRoster');
		const listAfterLeaving = await spaceMemberList(groupToken, membersSpaceUri);
		record(
			beforeLeaving.status === 200 &&
				notFound(afterLeaving) &&
				!rosterAfterLeaving.roster.some((entry) => entry.did === BOB) &&
				listAfterLeaving.status === 200 &&
				!listAfterLeaving.members.some((m) => m.did === BOB),
			"leaving deletes the member's acceptance, and takes them off the roster and the members list",
			`acceptance before leave ${beforeLeaving.error ?? beforeLeaving.status}, after ` +
				`${afterLeaving.error ?? afterLeaving.status}; on the roster ` +
				`${rosterAfterLeaving.roster.some((entry) => entry.did === BOB)}; on the members list ` +
				`${listAfterLeaving.members.some((m) => m.did === BOB)}`
		);

		// 18d. a direct add is unconfirmed until the member's next sign-in -----------
		// The member was not there to write an acceptance. They can still read,
		// because access comes from membership alone, and the roster shows them,
		// unconfirmed. The sign-in callback's write then confirms them.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const addedRoster = await op('confirmedRoster');
		const bobAdded = addedRoster.roster.find((entry) => entry.did === BOB);
		const addedGate = await op('gate', { did: BOB });
		const beforeSignIn = await ownAcceptance(bobToken, membersSpaceUri);
		await op('signInAcceptances', { did: BOB });
		const afterSignIn = await ownAcceptance(bobToken, membersSpaceUri);
		const signedInRoster = await op('confirmedRoster');
		const bobSignedIn = signedInRoster.roster.find((entry) => entry.did === BOB);
		record(
			bobAdded?.confirmed === false &&
				addedGate.onRoster === true &&
				addedGate.canSee === true &&
				notFound(beforeSignIn) &&
				afterSignIn.status === 200 &&
				bobSignedIn?.confirmed === true,
			'a member added directly can read and shows as unconfirmed, and their next sign-in writes the acceptance that confirms them',
			`added: confirmed ${bobAdded?.confirmed}, on the roster ${addedGate.onRoster}, can see ` +
				`${addedGate.canSee}; acceptance before sign-in ${beforeSignIn.error ?? beforeSignIn.status}, ` +
				`after ${afterSignIn.error ?? afterSignIn.status}; confirmed after ${bobSignedIn?.confirmed}`
		);
		// Back out the same way, so checks 19-23 see the roster check 18 left.
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		note(`${BOB} left again (acceptance deleted, roster back to the owner alone)`);

		// 18e. a member whose PDS serves no spaces ---------------------------------
		// Use case step 4. Their PDS drops the group's grant at sign-in, so they can
		// never write an acceptance: they show unconfirmed, still read the group,
		// and their sign-in still works. The premise is checked first-hand: their
		// PDS must refuse the group's space read itself, since a RecordNotFound
		// would mean it serves spaces and the check proves nothing about step 4.
		const carolAsked = await op('joinGroup', {
			callerDid: CAROL,
			asMember: true,
			session: 'no-spaces',
			message: null
		});
		const carolsRequest = (await op('listJoinRequests')).find((request) => request.did === CAROL);
		await op('approveJoinRequest', {
			callerDid: ALICE,
			member: CAROL,
			role: 'member'
		});
		await op('signInCallback', { did: CAROL });
		const carolRoster = await op('confirmedRoster');
		const carolEntry = carolRoster.roster.find((entry) => entry.did === CAROL);
		const carolGate = await op('gate', { did: CAROL, session: 'no-spaces' });
		const carolRead = await op('spaceReadAt', { did: CAROL });
		const carolCalls = await must('noSpacesCalls');
		record(
			refusesSpaceRead(carolRead) &&
				carolAsked.outcome === 'pending' &&
				carolsRequest !== undefined &&
				carolEntry?.confirmed === false &&
				carolGate.onRoster === true &&
				carolGate.canSee === true &&
				carolGate.reads === false &&
				carolGate.groupCalls.length === 0 &&
				carolCalls.length === 0,
			'a member whose PDS serves no spaces is approved, shows as unconfirmed, sees the group as its row shows it with nothing read for them, and signs in with nothing sent from their session',
			`their PDS ${carolRead.host} answers the group's space read ${carolRead.status} ` +
				`${carolRead.error}; request ${carolAsked.outcome}, listed by the host ` +
				`${carolsRequest !== undefined}; confirmed ` +
				`${carolEntry ? carolEntry.confirmed : 'not on the roster'}; on the roster ` +
				`${carolGate.onRoster} (from the row), can see ${carolGate.canSee}, a reader ${carolGate.reads}, ` +
				`${carolGate.groupCalls.length} request(s) as the group; sent from their session ` +
				`${carolCalls.length > 0 ? carolCalls.join(', ') : 'nothing'}`
		);
		await op('leaveGroup', {
			callerDid: CAROL,
			asMember: true,
			session: 'no-spaces'
		});
		note(`${CAROL} left (roster back to the owner alone)`);

		// 19. the declaration: the record that lets other apps discover the group --
		// The create declared the public group. Asserted on the raw JSON an anonymous
		// peer app gets, not through our parser.
		const declaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			declaration.status === 200 &&
				declaration.value?.meta === aboutSpaceUri &&
				typeof declaration.value?.createdAt === 'string' &&
				// Discovery only: nothing that shows a stranger the group's name.
				Object.keys(declaration.value ?? {})
					.sort()
					.join(',') === '$type,createdAt,meta',
			'a public group is DECLARED in its public repo, readable with no credential',
			`anonymous getRecord ${declaration.status}; points at ${declaration.value?.meta}; ` +
				`fields ${Object.keys(declaration.value ?? {}).join(', ')}`
		);

		// 20. and turning private withdraws it --------------------------------------
		// A private group must not be announced, so its declaration is deleted. The
		// visibility is passed in, as the settings save passes the form's choice.
		await op('reconcileDeclaration', {
			callerDid: ALICE,
			visibility: 'private'
		});
		const withdrawn = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		await op('reconcileDeclaration', {
			callerDid: ALICE,
			visibility: 'public'
		});
		const redeclared = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			notFound(withdrawn) && redeclared.status === 200,
			'turning a group private DELETES its declaration; turning it back re-declares it',
			`private: ${withdrawn.error ?? withdrawn.status}; public again: ${redeclared.status}`
		);

		// 20b-20f. the access record is the policy, and the host follows it --------
		// SC-208: the group is flipped private, public, private and public again
		// through the settings save, the way an owner does it. After each flip the
		// about space's read policy at the PDS says what its access record says,
		// the declaration exists only while that is public, and a space credential
		// is issued exactly where the caller's roles, or a public policy, allow:
		// asked for first-hand from the PDS by the member, and by the same account
		// as a stranger once they have left. Each save's writes are read in order
		// from the group's session, so "the host is never more open than the
		// record" is seen live, not only in the unit tests: a narrowing closes the
		// host before the record says private, a widening has the record say public
		// before the host opens. (Spec: FR-214.)
		const spaceKinds = () => ({
			about: aboutSpaceUri,
			members: membersSpaceUri,
			calendar: calendarSpaceUri
		});
		/** The about space as the PDS holds it, and the declaration as a stranger sees it. */
		const visibilityNow = async () => {
			const policy = await spaceReadPolicy(groupToken, aboutSpaceUri);
			const access = await spaceRecord(groupToken, aboutSpaceUri, ACCESS_COLLECTION, 'self');
			const declaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
			const others = await Promise.all(
				[membersSpaceUri, calendarSpaceUri].map((space) => spaceReadPolicy(groupToken, space))
			);
			return {
				readPolicy: policy.readPolicy ?? policy.error ?? policy.status,
				accessPublic: access.value?.public,
				declared: declaration.status === 200,
				othersClosed: others.every((o) => o.readPolicy === READ_POLICY.private)
			};
		};
		/** Bob's own space credential for each space: `issued`, or why not. */
		const bobCredentials = async () => {
			const out = {};
			for (const [kind, space] of Object.entries(spaceKinds())) {
				const asked = await spaceCredentialRequest(bobToken, space);
				out[kind] = asked.issued ? 'issued' : `${asked.status} ${asked.error ?? asked.stage}`;
			}
			return out;
		};
		/** One settings save, and the writes it sent, labelled by what they wrote. */
		const saveVisibility = async (visibility, shownVisibility, requireApproval) => {
			const { total: from } = await must('groupWrites', {});
			const result = await op('saveSettings', {
				callerDid: ALICE,
				visibility,
				shownVisibility,
				...(requireApproval === undefined ? {} : { requireApproval })
			});
			const { writes } = await must('groupWrites', { from });
			return { result, writes };
		};
		/** Where each labelled write falls in a save's sequence, -1 when absent. */
		const at = (writes, label) => writes.indexOf(label);
		const ACCESS_WRITE = `space.putRecord ${ACCESS_COLLECTION}`;
		const OPEN = 'simplespace.updateSpace publicPolicy';
		const CLOSE = 'simplespace.updateSpace memberListPolicy';
		const DECLARE = `repo.putRecord ${DECLARATION_COLLECTION}`;
		const WITHDRAW = `repo.deleteRecord ${DECLARATION_COLLECTION}`;
		const ISSUED_ALL = { about: 'issued', members: 'issued', calendar: 'issued' };
		const sameCredentials = (got, want) =>
			Object.keys(want).every((kind) =>
				want[kind] === 'issued' ? got[kind] === 'issued' : got[kind] !== 'issued'
			);
		const describeFlip = (state, creds, writes) =>
			`getSpace ${state.readPolicy}; access public ${state.accessPublic}; declared ${state.declared}; ` +
			`members and calendar closed ${state.othersClosed}; ${BOB} credentials ` +
			`${Object.entries(creds)
				.map(([k, v]) => `${k} ${v}`)
				.join(', ')}; writes ${writes.join(' > ') || '(none)'}`;

		// 20b. a stranger is shut out once the group is private --------------------
		// Bob left at 18d, so here he is a stranger with a session of his own.
		const toPrivate = await saveVisibility('private', 'public', true);
		const privateState = await visibilityNow();
		const strangerCreds = await bobCredentials();
		record(
			toPrivate.result.ok === true &&
				privateState.readPolicy === READ_POLICY.private &&
				privateState.accessPublic === false &&
				!privateState.declared &&
				privateState.othersClosed &&
				at(toPrivate.writes, CLOSE) >= 0 &&
				at(toPrivate.writes, CLOSE) < at(toPrivate.writes, WITHDRAW) &&
				at(toPrivate.writes, WITHDRAW) < at(toPrivate.writes, ACCESS_WRITE) &&
				at(toPrivate.writes, OPEN) === -1 &&
				sameCredentials(strangerCreds, {
					about: 'refused',
					members: 'refused',
					calendar: 'refused'
				}),
			'saved private, the PDS closes the about space before the declaration goes and before the access record says private, and a stranger gets no credential for any space',
			describeFlip(privateState, strangerCreds, toPrivate.writes)
		);

		// 20c. and its door is shut to strangers ---------------------------------
		// The join is passed no visibility, so it reads the access record.
		const strangerJoin = await tryOp('joinGroup', {
			callerDid: MALLORY,
			message: 'let me in'
		});
		const requestsNow = await op('listJoinRequests', { status: 'all' });
		const ownerGate = await op('gate', { did: ALICE });
		const strangerGate = await op('gate', { did: MALLORY });
		const repeated = await op('reconcileDeclaration', { callerDid: ALICE, visibility: 'record' });
		const stillWithdrawn = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			!strangerJoin.ok &&
				strangerJoin.error.reason === 'invite-only' &&
				!requestsNow.some((request) => request.did === MALLORY) &&
				ownerGate.canSee === true &&
				strangerGate.canSee === false &&
				repeated.visibility === 'private' &&
				notFound(stillWithdrawn),
			"a private group refuses a stranger's join and records no request, its gate admits the owner only, and withdrawing its declaration again by the record is a no-op",
			`${MALLORY} join: ${strangerJoin.ok ? `ACCEPTED (${strangerJoin.value.outcome})` : strangerJoin.error.reason}; ` +
				`requests from them ${requestsNow.filter((request) => request.did === MALLORY).length}; ` +
				`gate: owner ${ownerGate.canSee}, stranger ${strangerGate.canSee}; ` +
				`by the record: ${repeated.visibility}, declaration ${stillWithdrawn.error ?? stillWithdrawn.status}`
		);

		// 20d. a member of a private group gets a credential for every space -------
		// Every role reads every space, so admitting Bob lists him on all three.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const memberLists = await Promise.all(
			Object.values(spaceKinds()).map((space) => spaceMemberList(groupToken, space))
		);
		const memberPrivateCreds = await bobCredentials();
		record(
			memberLists.every((list) => {
				const entry = list.members.find((m) => m.did === BOB);
				return list.status === 200 && entry?.read === true && entry?.write === true;
			}) && sameCredentials(memberPrivateCreds, ISSUED_ALL),
			"a member admitted to a private group is on all three spaces' lists, read and write, and the PDS issues them a credential for each",
			`lists ${memberLists
				.map((list) => JSON.stringify(list.members.find((m) => m.did === BOB) ?? null))
				.join(', ')}; credentials ${JSON.stringify(memberPrivateCreds)}`
		);

		// 20e. private to public to private, with the member on board ---------------
		const toPublic = await saveVisibility('public', 'private');
		const publicState = await visibilityNow();
		const memberPublicCreds = await bobCredentials();
		const backToPrivate = await saveVisibility('private', 'public', true);
		const privateAgain = await visibilityNow();
		const memberPrivateAgain = await bobCredentials();
		record(
			toPublic.result.ok === true &&
				publicState.readPolicy === READ_POLICY.public &&
				publicState.accessPublic === true &&
				publicState.declared &&
				publicState.othersClosed &&
				at(toPublic.writes, ACCESS_WRITE) >= 0 &&
				at(toPublic.writes, ACCESS_WRITE) < at(toPublic.writes, OPEN) &&
				at(toPublic.writes, OPEN) < at(toPublic.writes, DECLARE) &&
				at(toPublic.writes, CLOSE) === -1 &&
				sameCredentials(memberPublicCreds, ISSUED_ALL) &&
				backToPrivate.result.ok === true &&
				privateAgain.readPolicy === READ_POLICY.private &&
				privateAgain.accessPublic === false &&
				!privateAgain.declared &&
				privateAgain.othersClosed &&
				at(backToPrivate.writes, CLOSE) >= 0 &&
				at(backToPrivate.writes, CLOSE) < at(backToPrivate.writes, WITHDRAW) &&
				at(backToPrivate.writes, WITHDRAW) < at(backToPrivate.writes, ACCESS_WRITE) &&
				sameCredentials(memberPrivateAgain, ISSUED_ALL),
			'saved public, the access record says public before the PDS opens the about space and before the declaration; saved private again, the PDS closes first; the member holds a credential for every space throughout',
			`public: ${describeFlip(publicState, memberPublicCreds, toPublic.writes)} || ` +
				`private: ${describeFlip(privateAgain, memberPrivateAgain, backToPrivate.writes)}`
		);

		// 20f. back to public, as created, with the stranger let in only up front ---
		// Bob leaves, then the group goes back to its create-time visibility and
		// approval, so checks 21-23 see what 18d left. A stranger to a public group
		// gets a credential for its about space and for nothing else.
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		const leftLists = await Promise.all(
			Object.values(spaceKinds()).map((space) => spaceMemberList(groupToken, space))
		);
		const leftCreds = await bobCredentials();
		const backAsCreated = await saveVisibility(
			CREATE_VISIBILITY,
			'private',
			CREATE_DATA.requireApproval
		);
		const restoredState = await visibilityNow();
		const strangerPublicCreds = await bobCredentials();
		record(
			leftLists.every((list) => list.status === 200 && !list.members.some((m) => m.did === BOB)) &&
				sameCredentials(leftCreds, { about: 'refused', members: 'refused', calendar: 'refused' }) &&
				backAsCreated.result.ok === true &&
				restoredState.readPolicy === READ_POLICY.public &&
				restoredState.accessPublic === true &&
				restoredState.declared &&
				sameCredentials(strangerPublicCreds, {
					about: 'issued',
					members: 'refused',
					calendar: 'refused'
				}),
			'a member who leaves a private group is off every list and refused every credential; public again, a stranger gets a credential for the about space only',
			`after leaving: on a list ${leftLists.some((list) => list.members.some((m) => m.did === BOB))}, ` +
				`credentials ${JSON.stringify(leftCreds)}; public again: ` +
				describeFlip(restoredState, strangerPublicCreds, backAsCreated.writes)
		);
		note(`${BOB} left again; the group is ${CREATE_VISIBILITY} again, as created`);

		// 21. the events tab's list comes from the index, not the PDS -------------
		// The tab reads the app's index, like any other account's events, and not the
		// group's repo.
		const indexed = await op('listGroupEvents');
		const indexedNames = indexed.map((e) => e.value?.name);
		record(
			indexed.length === 2 &&
				indexed.every((e) => authorityOf(e.uri) === GROUP_DID) &&
				indexedNames.includes(editedName) &&
				indexedNames.includes('e2e paddle, with a cover image') &&
				!indexedNames.includes('e2e sunrise paddle'),
			"the events tab reads the group's events from the index, edits included",
			`${indexed.length} indexed record(s), all authored by ${GROUP_DID}: ${indexedNames.join(' | ')}`
		);

		// 22. and a write after that read still shows up ---------------------------
		// An actor-scoped query backfills a repo only once, so check 21 could pass on
		// the backfill alone. A write and a delete after it, with no cron tick, show
		// that the write gate updates the index itself.
		const afterBackfill = await op('writeGroupEvent', {
			callerDid: ALICE,
			placement: 'everyone',
			intent: 'create',
			record: eventRecord('e2e paddle, written after the index had caught up')
		});
		written.push(afterBackfill.rkey);
		const withThird = await op('listGroupEvents');
		await op('deleteGroupEvent', {
			callerDid: ALICE,
			placement: 'everyone',
			rkey: afterBackfill.rkey
		});
		const afterDelete = await op('listGroupEvents');
		record(
			withThird.some((e) => e.rkey === afterBackfill.rkey) &&
				withThird.length === 3 &&
				afterDelete.every((e) => e.rkey !== afterBackfill.rkey) &&
				afterDelete.length === 2,
			'an event written after the backfill is indexed at once, and a deletion drops it',
			`after the write ${withThird.length} indexed (${afterBackfill.rkey} present: ` +
				`${withThird.some((e) => e.rkey === afterBackfill.rkey)}); ` +
				`after the delete ${afterDelete.length}, with no cron tick between them`
		);

		// 23. the whole group, rebuilt from no row ---------------------------------
		// Last, because it replaces the row the checks above act through. Nothing is
		// restored for visibility, which stays in the about space's access record.
		const profileNow = await op('readGroupAbout');
		const rosterNow = await op('recordedRoster');
		const beforeDrop = await must('groupSnapshot', { groupDid: GROUP_DID });
		const wiped = await op('dropGroupRows');
		let restored;
		try {
			restored = await must('rebuildGroup', { groupDid: GROUP_DID, ownerDid: ALICE });
		} finally {
			// Cleanup needs a row: the restored one, or else a bare one on the same DID.
			group = restored
				? restored.group
				: await must('bindRow', { groupDid: GROUP_DID, ownerDid: ALICE });
		}
		const afterRebuild = await must('groupSnapshot', { groupDid: GROUP_DID });
		// id and updated_at are regenerated, and created_at comes from the profile.
		// Every other column must match exactly.
		const columnsOf = (snap) => {
			const rest = { ...snap.row };
			for (const key of ['id', 'created_at', 'updated_at']) delete rest[key];
			return JSON.stringify(rest);
		};
		const rosterOf = (snap) => snap.roster.map((m) => `${m.did}/${m.role}`).join(' ');
		const recordJoinedAt = Object.fromEntries(
			rosterNow.roster.map((entry) => [entry.did, entry.created_at])
		);
		const sameColumns = columnsOf(afterRebuild) === columnsOf(beforeDrop);
		const sameGrants = JSON.stringify(afterRebuild.grants) === JSON.stringify(beforeDrop.grants);
		record(
			wiped.left === null &&
				restored?.path === 'restored' &&
				!('visibility' in afterRebuild.row) &&
				sameColumns &&
				afterRebuild.row.created_at === Date.parse(profileNow.profile.createdAt) &&
				rosterOf(afterRebuild) === rosterOf(beforeDrop) &&
				afterRebuild.roster.every((m) => m.created_at === recordJoinedAt[m.did]) &&
				sameGrants,
			'the group, deleted down to its credential, is rebuilt from its DID alone',
			`path ${restored?.path}; ` +
				`columns ${sameColumns ? 'identical' : 'DIFFER'}; roster ${rosterOf(afterRebuild)}; ` +
				`${afterRebuild.grants.length} role grant row(s) ${sameGrants ? 'identical' : 'DIFFER'}`
		);
	} finally {
		// The group is this run's alone and is left behind, so cleanup undoes only
		// what shows outside it: its public events and its declaration, and the
		// records the admin wrote into their own repo.
		if (written.length > 0) console.log('');
		for (const rkey of written) {
			const uri = `at://${GROUP_DID}/${EVENT_COLLECTION}/${rkey}`;
			let refusal;
			try {
				const deleted = await tryOp('deleteGroupEvent', {
					callerDid: ALICE,
					placement: 'everyone',
					rkey
				});
				if (!deleted.ok) refusal = `${deleted.error.name}: ${deleted.error.message}`;
			} catch (error) {
				refusal = error.message;
			}
			const after = await getRecord(GROUP_DID, rkey);
			if (notFound(after)) {
				note(`cleaned up ${uri} (${after.error})`);
			} else {
				console.log(
					`WARN  could not confirm ${uri} is gone: ${refusal ?? after.error ?? after.status}`
				);
			}
		}
		// The admin's RSVP to the seed, with their own session: should 13t or 13v
		// have stopped before its cancel, it would be in the calendar space.
		if (rsvpWritten) {
			try {
				const after = await deleteOwnRsvp(bobToken);
				if (notFound(after)) note(`deleted ${BOB}'s RSVP to the seed (${after.error})`);
				else
					console.log(
						`WARN  ${BOB}'s RSVP to the seed may be left: ${after.error ?? after.status}`
					);
			} catch (error) {
				console.log(`WARN  could not delete ${BOB}'s RSVP to the seed: ${error.message}`);
			}
		}
		// Should a check have stopped before the admin left, their acceptance would
		// still be in their repo.
		if (acceptanceWritten) {
			try {
				await deleteOwnAcceptance(bobToken, membersSpaceUri);
				const after = await ownAcceptance(bobToken, membersSpaceUri);
				if (notFound(after)) note(`deleted ${BOB}'s acceptance (${after.error})`);
				else console.log(`WARN  ${BOB}'s acceptance may be left: ${after.error ?? after.status}`);
			} catch (error) {
				console.log(`WARN  could not delete ${BOB}'s acceptance: ${error.message}`);
			}
		}
		// A leftover declaration would keep announcing a test group to the network.
		if (declared && group) {
			try {
				await tryOp('reconcileDeclaration', {
					callerDid: ALICE,
					visibility: 'private'
				});
				const after = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
				if (notFound(after)) {
					note(`withdrew the declaration (${after.error})`);
				} else {
					console.log(
						`WARN  could not confirm ${GROUP_DID} is no longer declared: ${after.error ?? after.status}`
					);
				}
			} catch (error) {
				console.log(`WARN  could not withdraw the declaration: ${error.message}`);
			}
		}
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

// 24. no request left this machine --------------------------------------------
// Recorded once main() has returned, so cleanup's requests are counted too. It
// needs no public request, and at least one local request from the worker and
// one from the driver after its startup checks, so a ledger that saw nothing
// cannot pass.
const network = ledger.verdict();
record(network.ok, 'no request left this machine', network.detail);

const passed = results.filter((entry) => entry.ok).length;
const failed = results.length - passed;
console.log('');
console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0 && failure?.stack) console.error(failure.stack);
process.exit(failed > 0 ? 1 : 0);

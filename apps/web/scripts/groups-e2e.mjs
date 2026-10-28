#!/usr/bin/env node
/**
 * End-to-end test of groups against a live group host and the PDSes that serve its
 * spaces, on a snowglobe (`pnpm globe:e2e`).
 *
 *   node apps/web/scripts/groups-e2e.mjs
 *
 * It runs 37 numbered checks and prints one PASS or FAIL line each; a clean run ends
 * with `SUMMARY: 37 passed, 0 failed`. Setup steps print as notes. In order: the group
 * made at the host's own sign-up and the app's set-up after it (1), each person's sign-in
 * with the participate set (2), events written as the group DID and the write gate
 * (3-6), a cover image in the group's repo (7), the profile, rules and access records
 * (8-10), the authz config and a demotion (11-13), the roster acts: eject, a join request,
 * a direct add, a member whose PDS serves no spaces (14-17), the declaration and an
 * unlisted public group (18-19), the group saved private, public, private and public
 * again, with each space credential issued exactly where the caller's roles or a public
 * meta space allow (20-24), an open join (25), the events index (26-27), members-only
 * events in the calendar space and members' RSVPs to them (28-32), acceptances and the
 * confirmed roster (33-35), a members-only delete (36), and, once cleanup is done, that no
 * request left this machine (37).
 *
 * The real $lib/groups modules run on workerd with a real D1 binding: Vite bundles
 * scripts/groups-e2e.worker.ts, a thin JSON entry onto them, and Miniflare runs it. D1
 * lives in a temporary directory deleted on exit. Writes are confirmed by reading them
 * back, never from the writer's return value. Each person signs in for real through a
 * loopback OAuth client and a Chromium on the globe (scripts/groups-e2e.signin.mjs); the
 * worker reaches those sessions through a bridge on this machine
 * (scripts/groups-e2e.oauth.ts). The host's refusals are read back from its own record
 * (`/spike/state`). Each run makes its own group and leaves its did:plc behind; cleanup
 * deletes the public events, withdraws the declaration and signs every session out.
 *
 * Environment (snowglobe.yml's `e2e` app sets them):
 *   E2E_GROUP_HOST, E2E_PDS, E2E_PLC_URL   the globe's group host, spaces PDS and PLC
 *   E2E_OWNER_*, E2E_ADMIN_*, E2E_OUTSIDER_*  DID, handle and password of the owner, a
 *                                         member promoted to admin, and a non-member
 *   E2E_NOSPACES_DID                      a person on a PDS that serves no spaces
 *   E2E_CREDENTIALS                       an env file holding the handles and passwords
 *   E2E_PLAYWRIGHT                        the playwright package, if not the app's own
 * No request leaves this machine: every one is counted, a non-local one is refused, and
 * check 28 reports the count.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** Every request the run sends, from this driver and from the worker, for check 28. */
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

/** The group host the run makes its group at. */
const GROUP_HOST = required('E2E_GROUP_HOST');

/** Where the group's repo and spaces live: the host. */
const GROUP_PDS = GROUP_HOST;

const PLAYWRIGHT = process.env.E2E_PLAYWRIGHT?.trim() || 'playwright';

/** Devnet's PLC directory. scripts/groups-e2e.identity-resolver.ts asks it and
 *  nothing else, so a DID it lacks fails to resolve. */
const PLC_URL = required('E2E_PLC_URL');

/** The owner, a member promoted to admin, and a non-member. The run writes to none of
 *  their own repos. */
const ALICE = required('E2E_OWNER_DID');
const BOB = required('E2E_ADMIN_DID');
const MALLORY = required('E2E_OUTSIDER_DID');

/** Use case step 4's member, on a PDS that serves no spaces. */
const CAROL = required('E2E_NOSPACES_DID');

const GROUP_ROLES = ['admin', 'member'];
/** What an admin's grant resolves to, sorted. A member resolves to none. */
const ALL_SIX = [
	'ADMIT_MEMBERS',
	'ASSIGN_ROLES',
	'CREATE_EVENT',
	'EJECT_MEMBERS',
	'MANAGE_EVENTS',
	'MANAGE_GROUP'
];

/** The run's group label: new each run, and within the PDS's 18 characters. */
const GROUP_LABEL = `e2eh${Date.now().toString(36)}`;
/** The create form, as the host's sign-up carries it. */
const CREATE_DATA = {
	name: 'groups e2e',
	description: 'A group made by apps/web/scripts/groups-e2e.mjs for one run.',
	visibility: 'public',
	joinPolicy: 'approval',
	listed: true,
	rules: 'Be kind\nNo spam\nStay on topic'
};

let GROUP_DID;
function useGroup(did) {
	GROUP_DID = did;
}

const EVENT_COLLECTION = 'community.lexicon.calendar.event';
const ACCESS_COLLECTION = 'group.opensocial.access';
const MEMBERSHIP_COLLECTION = 'group.opensocial.membership';
const DECLARATION_COLLECTION = 'group.opensocial.declaration';
const META_TYPE = 'group.opensocial.meta';
const MEMBERS_TYPE = 'group.opensocial.members';
const PARTICIPATE = 'include:group.opensocial.participate';
/** The profile record's fields once atmo has written it. */
const PROFILE_KEYS = ['$type', 'description', 'displayName', 'joinPolicy'];

/** Only fills `request.url`. The host never resolves and is never connected to. */
const ORIGIN = 'http://groups-e2e.invalid';
/** Matches apps/web/wrangler.jsonc. */
const COMPATIBILITY_DATE = '2025-12-25';

/** Whether a granted scope reads spaces of `type`, as a PDS hands an include back expanded. */
function readsSpaceOf(scope, type) {
	return scope.split(' ').some((token) => {
		const [resource, query = ''] = token.split('?');
		if (resource !== `space:${type}` && resource !== 'space:*') return false;
		const actions = new URLSearchParams(query).getAll('action');
		return actions.length === 0 || actions.includes('read');
	});
}

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
	if (!body.ok) throw new Error(`${op} failed: ${body.error.name}: ${body.error.message}`);
	return body.value;
}

/** Bundles the Worker (./groups-e2e.build.mjs) and starts it in Miniflare. */
async function startWorker(stateDir, bridgeUrl) {
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
			// Only for the create's check that linking is configured. Nothing is
			// fetched from it: the driver's sign-ins link the group.
			OAUTH_PUBLIC_URL: ORIGIN,
			// The host, as on a deployment, and the driver's bridge to every real
			// session.
			GROUP_HOST_URL: GROUP_HOST,
			E2E_BRIDGE: bridgeUrl
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
	if (!value || 'readRoles' in value) return false;
	// The host writes the meta and members records at create, each role's grant
	// in its own words (admin's covers every action), so each role must read.
	const grants = value.grants ?? [];
	const roles = grants.map((grant) => grant.role).sort();
	return (
		JSON.stringify(roles) === JSON.stringify([...GROUP_ROLES].sort()) &&
		grants.every((grant) => (grant.scopes ?? []).some((s) => readsSpace(s, spaceType)))
	);
}

/** Whether an `access` record keeps its space closed. A host writes the meta and
 *  members records with no `public` at all, which is not public. */
function notPublic(value) {
	return !!value && value.public !== true;
}

/** Whether a `space:` scope reads spaces of `type`: it names no action, which is
 *  every action, or names `read`. */
function readsSpace(scope, type) {
	const [resource, query = ''] = String(scope).split('?');
	if (resource !== `space:${type}`) return false;
	const actions = new URLSearchParams(query).getAll('action');
	return actions.length === 0 || actions.includes('read');
}

/** A PDS that serves no spaces refuses a space read itself: a 4xx, or 501 for
 *  a method it lacks. A RecordNotFound, or a credential it calls expired or
 *  revoked, comes from a PDS that serves spaces, and a 5xx says nothing. */
function refusesSpaceRead(read) {
	const spacesAnswer = ['RecordNotFound', 'JwtExpired', 'CredentialRevoked'];
	const refused = read.status === 501 || (read.status >= 400 && read.status < 500);
	return refused && !spacesAnswer.includes(read.error);
}

/** One request on `auth`, a real OAuth session, which sends it to its own
 *  service. With no `auth`, an anonymous request to `url`. */
function send(url, init, auth) {
	if (auth) return auth.handle(url.pathname + url.search, init);
	return fetch(url, init);
}

/** One XRPC query, as `send` takes `token`. Answers the status and the JSON body,
 *  `{}` when the body is not JSON. */
async function pdsGet(nsid, params, token, base = PDS) {
	const url = new URL(`/xrpc/${nsid}`, base);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
	const response = await send(url, { method: 'GET' }, token);
	return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** The group host's own record of the run's group: what it refused (by its write
 *  gate, its PDS, or its sign-in), and how it cut each session to its person's
 *  roles. The spike host's devnet-only `/spike/state`. */
async function hostState() {
	const url = new URL('/spike/state', GROUP_HOST);
	url.searchParams.set('group', GROUP_DID);
	const response = await send(url, { method: 'GET' }, null);
	if (!response.ok) throw new Error(`the host's state answered ${response.status}`);
	return response.json();
}

/** The PDS that holds `repo`'s public records: the group's own, or E2E_PDS. */
function repoHost(repo) {
	return repo === GROUP_DID ? GROUP_PDS : PDS;
}

/** Unauthenticated read straight from the repo's PDS. */
async function getRecord(repo, rkey, collection = EVENT_COLLECTION) {
	const { status, body } = await pdsGet(
		'com.atproto.repo.getRecord',
		{ repo, collection, rkey },
		null,
		repoHost(repo)
	);
	return { status, ...body };
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

/** A user's own request for a space credential, as another app would make it:
 *  a delegation token from their session, then `getSpaceCredential` with that
 *  token and a key made for the request, both in the body, as the 2026-10-22
 *  spaces alpha takes them. Shares no code with the app. (Spec: SC-202.) */
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
	const response = await fetch(new URL('/xrpc/com.atproto.space.getSpaceCredential', GROUP_PDS), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ space, credentialKid: keyId, delegationToken: delegated.body.token })
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

/** The `at://<authority>/...` a record actually landed under. */
function authorityOf(uri) {
	return String(uri).slice('at://'.length).split('/')[0];
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

/** A blob read anonymously, the way any CDN or stranger would fetch it. */
async function anonymousBlob(cid) {
	const url = new URL('/xrpc/com.atproto.sync.getBlob', GROUP_PDS);
	url.searchParams.set('did', GROUP_DID);
	url.searchParams.set('cid', String(cid));
	const response = await fetch(url);
	const body = response.ok ? {} : await response.json().catch(() => ({}));
	return { status: response.status, error: body.error };
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
	const settings = {
		E2E_PDS: PDS,
		E2E_PLC_URL: PLC_URL,
		E2E_GROUP_HOST: GROUP_HOST
	};
	const asked = Object.values(settings).filter((url) => !isLoopback(url) && URL.canParse(url));
	const hostnames = asked.map((u) => new URL(u).hostname).filter(Boolean);
	for (const name of await localNames(hostnames)) localHosts.add(name);
	let refusals = settingRefusals(settings, localHosts);
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
	console.log(`  host    ${GROUP_HOST}, which makes the group ${GROUP_LABEL} for this run`);
	console.log(`  humans  owner ${ALICE}, admin ${BOB}, non-member ${MALLORY}`);
	console.log(`          no-spaces member ${CAROL}`);
	console.log('');

	await refuseOffMachine();
	ledger.startRun();

	const { path } = await loadSecret('E2E_ADMIN_PASSWORD');
	note(`fixture credentials loaded from ${path}`);
	/** The admin's own sign-in, for his own space credential requests. */
	let bobToken = null;
	const person = async (did, prefix) => ({
		did,
		handle: (await loadSecret(`${prefix}_HANDLE`)).value,
		password: (await loadSecret(`${prefix}_PASSWORD`)).value
	});
	const people = {
		owner: await person(ALICE, 'E2E_OWNER'),
		admin: await person(BOB, 'E2E_ADMIN'),
		outsider: await person(MALLORY, 'E2E_OUTSIDER')
	};
	// Imported only now, after the fetch guard: the sign-ins' requests are counted.
	const { createSignIns, startBridge } = await import('./groups-e2e.signin.mjs');
	const bridge = await startBridge();
	const signIns = await createSignIns({
		plcUrl: PLC_URL,
		fetch,
		ledger,
		playwright: PLAYWRIGHT,
		log: note
	});
	const realSessions = [];

	const stateDir = await mkdtemp(join(tmpdir(), 'groups-e2e-'));
	let worker;
	let group;
	const op = (name, args = {}) => must(name, { groupId: group.id, ...args });
	const tryOp = (name, args = {}) => call(name, { groupId: group.id, ...args });
	const tracedOp = (name, args = {}) => traced(name, { groupId: group.id, ...args });
	/** The owner's group session, for reading the group's spaces with no app code. */
	let groupToken;
	const written = [];
	const membersOnlyWritten = [];
	let membersSpaceUri;
	let aboutSpaceUri;
	let declared = false;
	try {
		worker = await startWorker(stateDir, bridge.url);
		note(`worker bundled and ready in ${worker.seconds}s (workerd, empty D1 under ${stateDir})`);
		console.log('');

		// 1. create: the host's sign-up makes the group, then the app's set-up runs on the
		// creator's new session, as the create's callback does.
		{
			const { link } = await must('scopes', {});
			const made = await signIns.group(people.owner, {
				create: { label: GROUP_LABEL },
				scope: link,
				host: GROUP_HOST
			});
			realSessions.push(made.session);
			useGroup(made.session.did);
			groupToken = made.session;
			bridge.setGroup(GROUP_DID, ALICE, made.session);
			await must('linkGroup', { groupDid: GROUP_DID, personDid: ALICE });
			const setUp = await must('setUpHostGroup', {
				groupDid: GROUP_DID,
				ownerDid: ALICE,
				fields: CREATE_DATA
			});
			declared = true;
			if (!setUp.ok) throw new Error(`the set-up failed: ${setUp.error}`);
			group = await must('groupByDid', { groupDid: GROUP_DID });
			membersSpaceUri = group.members_space_uri;
			aboutSpaceUri = group.about_space_uri;
			const described = await pdsGet(
				'com.atproto.repo.describeRepo',
				{ repo: GROUP_DID },
				null,
				GROUP_PDS
			);
			const handle = described.body.handle;
			note(`${handle} is ${GROUP_DID}, made by the host and linked by ${ALICE}`);
			const members = await op('listMembers');
			const creatorRecord = await spaceRecord(
				groupToken,
				membersSpaceUri,
				MEMBERSHIP_COLLECTION,
				ALICE
			);
			record(
				setUp.atHost === true &&
					described.status === 200 &&
					handle?.startsWith(`${GROUP_LABEL}.`) &&
					described.body.handleIsCorrect === true &&
					made.keyPage === true &&
					made.consent.dropped.length === 0 &&
					members.length === 1 &&
					members[0].did === ALICE &&
					members[0].role === 'admin' &&
					aboutSpaceUri === `at://${GROUP_DID}/space/group.opensocial.meta/self` &&
					membersSpaceUri === `at://${GROUP_DID}/space/group.opensocial.members/self` &&
					creatorRecord.status === 200 &&
					JSON.stringify(creatorRecord.value?.roles) === JSON.stringify(['admin']),
				"at the host: its sign-up makes the group and shows her its recovery key, the app's set-up runs on the creator's session with the whole scope it asked for, and the host's record makes her an admin",
				`${handle} (${GROUP_DID}) at the host ${setUp.atHost}, handle verified ` +
					`${described.body.handleIsCorrect}; recovery key page ${made.keyPage ? 'shown (not read)' : 'NOT shown'}; consent offered ${made.consent.kept.length}, dropped ` +
					`${made.consent.dropped.length}${made.consent.dropped.length ? ` (${made.consent.dropped.join('; ')})` : ''}; ` +
					`app roster ${members.map((m) => `${m.did}/${m.role}`).join(' ')}; ` +
					`her membership record ${creatorRecord.error ?? JSON.stringify(creatorRecord.value?.roles)}`
			);

			// 2. each person's own sign-in asks for the proposal's participate set.
			const { signIn } = await must('scopes', {});
			const granted = {};
			for (const who of [people.owner, people.admin, people.outsider]) {
				const own = await signIns.own(who, signIn);
				realSessions.push(own.session);
				bridge.setOwn(who.did, own.session, own.scope);
				granted[who.did] = own.scope;
				if (who.did === BOB) bobToken = own.session;
			}
			record(
				signIn.split(' ').includes(PARTICIPATE) &&
					Object.values(granted).every(
						(scope) => readsSpaceOf(scope, META_TYPE) && readsSpaceOf(scope, MEMBERS_TYPE)
					),
				'a sign-in asks for the participate set, and a spaces PDS grants its meta and members reads',
				Object.entries(granted)
					.map(
						([did, scope]) =>
							`${did}: meta ${readsSpaceOf(scope, META_TYPE)}, members ${readsSpaceOf(scope, MEMBERS_TYPE)}`
					)
					.join('; ')
			);
		}

		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
		note(`${BOB} admitted and promoted to admin through the host`);

		// 3. the owner's event is the group's record.
		const created = await op('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			record: eventRecord('e2e sunrise paddle', { country: 'US' })
		});
		written.push(created.rkey);
		const asPersisted = await getRecord(GROUP_DID, created.rkey);
		const inOwnersRepo = await getRecord(ALICE, created.rkey);
		record(
			asPersisted.status === 200 &&
				authorityOf(asPersisted.uri) === GROUP_DID &&
				asPersisted.value?.name === 'e2e sunrise paddle' &&
				asPersisted.value?.locations?.[0]?.country === 'US' &&
				notFound(inOwnersRepo),
			"the owner's event is authored by the GROUP DID, not by the owner",
			`read back ${asPersisted.uri}; same rkey in the owner's repo: ` +
				`${inOwnersRepo.status === 200 ? 'PRESENT' : (inOwnersRepo.error ?? inOwnersRepo.status)}`
		);

		// 4. a write as the group goes out only on the acting person's own group session.
		const { total: beforeUnlinked } = await must('groupWrites', {});
		const unlinked = await tryOp('writeGroupEvent', {
			callerDid: BOB,
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
				unlinkedWrites.writes.length === 0 &&
				afterUnlinked.cid === asPersisted.cid,
			"an admin who has linked no group session is refused, and the creator's session writes nothing for him",
			`${unlinked.error?.name} for ${unlinked.error?.personDid}; ${unlinkedWrites.writes.length} write(s)`
		);

		// 5. an admin edits an event he did not create, on his own group session.
		{
			const { link } = await must('scopes', {});
			const linked = await signIns.group(people.admin, {
				groupDid: GROUP_DID,
				scope: link,
				host: GROUP_HOST
			});
			realSessions.push(linked.session);
			bridge.setGroup(GROUP_DID, BOB, linked.session);
			await must('linkGroup', { groupDid: GROUP_DID, personDid: BOB });
		}
		const { total: beforeEdit } = await must('groupWrites', {});
		const editedName = 'e2e sunrise paddle (rescheduled by admin bob)';
		const edited = await op('writeGroupEvent', {
			callerDid: BOB,
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord(editedName, { country: 'US', createdAt: asPersisted.value?.createdAt })
		});
		const adminEditWrites = await must('groupWrites', { from: beforeEdit });
		const afterEdit = await getRecord(GROUP_DID, created.rkey);
		const inAdminsRepo = await getRecord(BOB, created.rkey);
		record(
			edited.repo === GROUP_DID &&
				afterEdit.status === 200 &&
				authorityOf(afterEdit.uri) === GROUP_DID &&
				afterEdit.value?.name === editedName &&
				afterEdit.cid !== asPersisted.cid &&
				notFound(inAdminsRepo) &&
				adminEditWrites.by.length > 0 &&
				adminEditWrites.by.every((who) => who === BOB),
			'an admin edits an event he did not create, on his own group session; the author is still the GROUP DID',
			`"${afterEdit.value?.name}" at ${afterEdit.uri}; written on ` +
				`${[...new Set(adminEditWrites.by)].join(', ') || 'no'} session(s); admin's repo ` +
				`${inAdminsRepo.error ?? inAdminsRepo.status}`
		);

		// 6. a non-member has no group session to send an edit on, and the host refuses her one.
		const refused = await tracedOp('writeGroupEvent', {
			callerDid: MALLORY,
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord('e2e sunrise paddle (hijacked)', { country: 'US' })
		});
		const afterRefusal = await getRecord(GROUP_DID, created.rkey);
		{
			const { link } = await must('scopes', {});
			const signInRefusal = await signIns.groupRefused(people.outsider, {
				groupDid: GROUP_DID,
				scope: link
			});
			const hostRefused = (await hostState()).refusals.filter(
				(r) => r.by === 'sign-in' && r.personDid === MALLORY
			);
			record(
				refused.ok === false &&
					refused.error.name === 'GroupCredentialError' &&
					writesIn(refused.calls).length === 0 &&
					afterRefusal.cid === afterEdit.cid &&
					signInRefusal.status === 403 &&
					hostRefused.length === 1,
				"at the host: a non-member's edit has no session to go out on, and the host refuses her one",
				`${refused.error?.name}; ${writesIn(refused.calls).length} write(s) sent; her group sign-in ` +
					`${signInRefusal.status}; the host recorded ${hostRefused.length} sign-in refusal(s)`
			);
		}

		// 7. a cover image is uploaded into the group's repo, and the record cites it.
		const image = await op('uploadGroupEventImage', {
			callerDid: ALICE,
			intent: 'create',
			bytes: PNG_1PX,
			mimeType: 'image/png'
		});
		const withImage = await op('writeGroupEvent', {
			callerDid: ALICE,
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
			`${persistedWithImage.uri} cites ${cited}; getBlob ${blob.status}`
		);

		// 8. the create's profile and rules read back from the meta space.
		note(`meta space     ${aboutSpaceUri}`);
		note(`members space  ${membersSpaceUri}`);
		const about = await op('readGroupAbout', { personDid: ALICE });
		const profileKeys = Object.keys(about.profile?.record ?? {}).sort();
		record(
			about.profile?.name === CREATE_DATA.name &&
				about.profile?.description === CREATE_DATA.description &&
				about.profile?.joinPolicy === CREATE_DATA.joinPolicy &&
				profileKeys.every((key) => PROFILE_KEYS.includes(key)) &&
				about.rules.map((rule) => rule.text).join('|') === 'Be kind|No spam|Stay on topic',
			"the create's profile, with its join policy, and its rules read back out of the meta space",
			`joinPolicy ${about.profile?.joinPolicy}; profile keys ${profileKeys.join(', ')}; ` +
				`${about.rules.length} rule(s)`
		);

		// 9. the meta space's access record says the visibility the create chose.
		const aboutAccess = await spaceRecord(groupToken, aboutSpaceUri, ACCESS_COLLECTION, 'self');
		record(
			aboutAccess.status === 200 &&
				aboutAccess.value?.public === true &&
				grantsEveryRoleRead(aboutAccess.value, aboutSpaceUri),
			"at the host: the meta space's access record says public, as the create chose, and grants every role read",
			`public ${aboutAccess.value?.public}, grants ${JSON.stringify(aboutAccess.value?.grants)}`
		);

		// 10. the roster is membership records, keyed by member DID.
		const recorded = await op('recordedRoster', { personDid: ALICE, did: BOB });
		const bobsRecord = await spaceRecord(groupToken, membersSpaceUri, MEMBERSHIP_COLLECTION, BOB);
		const membersAccess = await spaceRecord(groupToken, membersSpaceUri, ACCESS_COLLECTION, 'self');
		record(
			recorded.source === 'records' &&
				recorded.roster.map((entry) => `${entry.did}/${entry.role}`).join(' ') ===
					`${ALICE}/admin ${BOB}/admin` &&
				recorded.hasAccess === true &&
				bobsRecord.status === 200 &&
				bobsRecord.value?.member === BOB &&
				JSON.stringify(bobsRecord.value?.roles) === JSON.stringify(['admin']) &&
				membersAccess.status === 200 &&
				notPublic(membersAccess.value) &&
				grantsEveryRoleRead(membersAccess.value, membersSpaceUri),
			'the roster is membership records in the members space, keyed by member DID, and that space is closed',
			`source ${recorded.source}; ${recorded.roster.length} member(s); ${BOB} at rkey=${BOB} ` +
				`${JSON.stringify(bobsRecord.value?.roles)}; members access public ${membersAccess.value?.public}`
		);

		// 11. the authz config is the host's records, and the app reads permissions from them.
		const authz = await op('recordedAuthz', { personDid: ALICE, role: 'admin' });
		const grantOf = (role) => (authz.grants ?? []).find((grant) => grant.role === role);
		record(
			authz.roles.join(',') === 'admin,member' &&
				JSON.stringify(grantOf('admin')?.assignable) === JSON.stringify(['admin', 'member']) &&
				(grantOf('member')?.scopes ?? []).length === 0 &&
				authz.effective.permissions.join(',') === ALL_SIX.join(','),
			"the roles and the permissions record are the host's, and an admin's grant reads as all six permissions",
			`roles [${authz.roles.join(', ')}]; admin assigns ${JSON.stringify(grantOf('admin')?.assignable)}; ` +
				`admin resolves to [${authz.effective.permissions.join(', ')}]`
		);

		// 12. a demotion rewrites the record to the smaller role, keeps the join date, and the
		// gate follows it.
		const joinedAt = recorded.memberships.find((m) => m.subject === BOB)?.createdAt;
		const probe = ['EJECT_MEMBERS', 'CREATE_EVENT'];
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const demotedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			MEMBERSHIP_COLLECTION,
			BOB
		);
		const demoted = await op('membership', { did: BOB, probe });
		await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
		const repromoted = await op('membership', { did: BOB, probe });
		record(
			JSON.stringify(demotedRecord.value?.roles) === JSON.stringify(['member']) &&
				demotedRecord.value?.createdAt === joinedAt &&
				demoted.role === 'member' &&
				demoted.permissions.length === 0 &&
				repromoted.role === 'admin' &&
				repromoted.can.EJECT_MEMBERS === true &&
				repromoted.can.CREATE_EVENT === true,
			'a demotion rewrites the membership record to the smaller role and the gate follows it; promoting back restores it',
			`demoted: ${JSON.stringify(demotedRecord.value?.roles)}, joined ${demotedRecord.value?.createdAt} ` +
				`(was ${joinedAt}), [${demoted.permissions.join(', ')}]; re-promoted ${repromoted.role}`
		);

		// 13. demoted, his writes go out on his own group session and the host refuses them; a
		// save that would first change only this site's copy is refused here, with nothing sent.
		{
			const before = await hostState();
			await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'member' });
			let attempts;
			try {
				const eventBefore = await getRecord(GROUP_DID, created.rkey);
				const edit = await tracedOp('writeGroupEvent', {
					callerDid: BOB,
					intent: 'update',
					rkey: created.rkey,
					record: eventRecord('e2e sunrise paddle (edited by a member)', {
						country: 'US',
						createdAt: eventBefore.value?.createdAt
					})
				});
				const eventAfter = await getRecord(GROUP_DID, created.rkey);
				const ownCopy = await tracedOp('saveSettings', {
					callerDid: BOB,
					visibility: 'public',
					shownVisibility: 'public'
				});
				const toPrivate = await tracedOp('saveSettings', {
					callerDid: BOB,
					visibility: 'private',
					shownVisibility: 'public'
				});
				const declaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
				const selfPromotion = await tracedOp('promoteMember', {
					callerDid: BOB,
					did: BOB,
					role: 'admin'
				});
				const ownRecord = await spaceRecord(
					groupToken,
					membersSpaceUri,
					MEMBERSHIP_COLLECTION,
					BOB
				);
				attempts = {
					eventBefore,
					edit,
					eventAfter,
					ownCopy,
					toPrivate,
					declaration,
					selfPromotion,
					ownRecord
				};
			} finally {
				await op('promoteMember', { callerDid: ALICE, did: BOB, role: 'admin' });
			}
			const {
				eventBefore,
				edit,
				eventAfter,
				ownCopy,
				toPrivate,
				declaration,
				selfPromotion,
				ownRecord
			} = attempts;
			const after = await hostState();
			const bobsRefusals = after.refusals
				.slice(before.refusals.length)
				.filter((r) => r.personDid === BOB);
			const cut = after.narrowings.some(
				(n) => n.personDid === BOB && n.at > (before.narrowings.at(-1)?.at ?? '')
			);
			const sentBy = (attempt) => writesIn(attempt.calls);
			const formRefused = (attempt) => attempt.ok === true && attempt.value?.ok === false;
			const sent = [edit, ownCopy, toPrivate, selfPromotion].reduce(
				(n, attempt) => n + sentBy(attempt).length,
				0
			);
			record(
				edit.ok === false &&
					sentBy(edit).length === 1 &&
					eventAfter.cid === eventBefore.cid &&
					formRefused(ownCopy) &&
					sentBy(ownCopy).length === 0 &&
					formRefused(toPrivate) &&
					JSON.stringify(sentBy(toPrivate)) === JSON.stringify(['com.atproto.repo.deleteRecord']) &&
					declaration.status === 200 &&
					selfPromotion.ok === false &&
					sentBy(selfPromotion).length === 1 &&
					JSON.stringify(ownRecord.value?.roles) === JSON.stringify(['member']) &&
					sent === 3 &&
					bobsRefusals.length === sent &&
					cut,
				"at the host: a member's event edit, a save turning the group private and making himself admin each go out on his own group session and are refused by the host; a save that would change only this site's copy is refused here, with nothing sent",
				`edit ${edit.error?.name ?? 'ALLOWED'} sent ${sentBy(edit).length}; save as it is ` +
					`${formRefused(ownCopy) ? 'refused' : 'ALLOWED'} sent ${sentBy(ownCopy).length}; save as private ` +
					`${formRefused(toPrivate) ? 'refused' : 'ALLOWED'} sent [${sentBy(toPrivate).join(', ')}], ` +
					`declaration ${declaration.status}; making himself admin ${selfPromotion.error?.name ?? 'ALLOWED'}, ` +
					`record ${JSON.stringify(ownRecord.value?.roles)}; the host recorded ${bobsRefusals.length} ` +
					`refusal(s) of ${sent} write(s) [${bobsRefusals.map((r) => `${r.by ?? 'gate'} ${r.nsid} ${r.error}`).join('; ')}]; ` +
					`his session ${cut ? 'was' : 'was NOT'} cut to his roles`
			);
		}

		// 14. an eject deletes the record, and a DID with no record has no access.
		await op('ejectMember', { callerDid: ALICE, did: BOB });
		const afterEject = await op('recordedRoster', { personDid: ALICE, did: BOB });
		const strangerCheck = await op('recordedRoster', { personDid: ALICE, did: MALLORY });
		const ejectedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			MEMBERSHIP_COLLECTION,
			BOB
		);
		record(
			notFound(ejectedRecord) &&
				afterEject.hasAccess === false &&
				strangerCheck.hasAccess === false &&
				afterEject.roster.map((entry) => entry.did).join(',') === ALICE,
			'a DID with no membership record has no access, whether ejected or never a member',
			`${BOB} after eject: record ${ejectedRecord.error ?? ejectedRecord.status}, access ` +
				`${afterEject.hasAccess}; ${MALLORY}: access ${strangerCheck.hasAccess}`
		);

		// 15. a join request to an approval group is the host's; approving it admits them, and
		// leaving takes them off again.
		const asked = await op('joinGroup', { callerDid: BOB, asMember: true, message: 'back again' });
		const credentialAtRequest = await spaceCredentialRequest(bobToken, membersSpaceUri);
		const pending = await op('listJoinRequests', { callerDid: ALICE });
		await op('approveJoinRequest', { callerDid: ALICE, member: BOB, role: 'member' });
		const credentialApproved = await spaceCredentialRequest(bobToken, membersSpaceUri);
		const approvedRoster = await op('recordedRoster', { personDid: ALICE, did: BOB });
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		const leftRoster = await op('recordedRoster', { personDid: ALICE, did: BOB });
		const credentialLeft = await spaceCredentialRequest(bobToken, membersSpaceUri);
		record(
			asked.outcome === 'pending' &&
				pending.some((request) => request.did === BOB) &&
				!credentialAtRequest.issued &&
				credentialApproved.issued &&
				approvedRoster.hasAccess === true &&
				leftRoster.hasAccess === false &&
				!credentialLeft.issued,
			'at the host: a join request is pending and gets no members credential; approved, the credential is issued; leaving takes it away',
			`request ${asked.outcome}, listed ${pending.some((r) => r.did === BOB)}; credential at request ` +
				`${JSON.stringify(credentialAtRequest)}, approved ${JSON.stringify(credentialApproved)}, ` +
				`after leaving ${JSON.stringify(credentialLeft)}`
		);

		// 16. a member added directly can read at once.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const addedGate = await op('gate', { did: BOB });
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		record(
			addedGate.onRoster === true && addedGate.canSee === true && addedGate.reads === true,
			'a member added directly is on the roster and reads the group with his own sign-in',
			`on the roster ${addedGate.onRoster}, can see ${addedGate.canSee}, reads ${addedGate.reads}`
		);

		// 17. a member whose PDS serves no spaces: never on the roster for a page, which shows
		// them the public group as anyone sees it, and nothing goes out on their session.
		await op('admitMember', { callerDid: ALICE, did: CAROL, role: 'member' });
		const carolRead = await op('spaceReadAt', { did: CAROL, personDid: ALICE });
		const carolGate = await op('gate', { did: CAROL, session: 'no-spaces' });
		const carolCalls = await must('noSpacesCalls');
		await op('ejectMember', { callerDid: ALICE, did: CAROL });
		record(
			refusesSpaceRead(carolRead) &&
				carolGate.onRoster === false &&
				carolGate.canSee === true &&
				carolGate.reads === false &&
				carolGate.signIn === true &&
				carolGate.groupCalls.length === 0 &&
				carolCalls.length === 0,
			'at the host: a member whose PDS serves no spaces is not taken as on the roster, sees the public group with nothing read for them, is asked to sign in again, and nothing is sent from their session',
			`their PDS answers a space read ${carolRead.status} ${carolRead.error}; on the roster ` +
				`${carolGate.onRoster}, can see ${carolGate.canSee}, reads ${carolGate.reads}, sign-in notice ` +
				`${carolGate.signIn}; ${carolGate.groupCalls.length} request(s) as the group; from their session ` +
				`${carolCalls.join(', ') || 'nothing'}`
		);

		// 18. a public, listed group is declared in its public repo, and the record names
		// only its meta space.
		const declaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			declaration.status === 200 &&
				declaration.value?.meta === aboutSpaceUri &&
				Object.keys(declaration.value ?? {})
					.sort()
					.join(',') === '$type,meta',
			'a public, listed group is DECLARED in its public repo, readable with no credential, naming only its meta space',
			`anonymous getRecord ${declaration.status}; fields ${Object.keys(declaration.value ?? {}).join(', ')}`
		);

		// 19. unlisted, a public group is withdrawn and stays public; a signed-out visitor no
		// longer finds it, a signed-in stranger still reads it; listed again, it is declared.
		const unlisted = await op('saveSettings', {
			callerDid: ALICE,
			visibility: 'public',
			shownVisibility: 'public',
			listed: false
		});
		const unlistedDeclaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		const unlistedAccess = await spaceRecord(groupToken, aboutSpaceUri, ACCESS_COLLECTION, 'self');
		const visitorGate = await op('gate', { did: null });
		const strangerSees = await op('gate', { did: MALLORY });
		const relisted = await op('saveSettings', {
			callerDid: ALICE,
			visibility: 'public',
			shownVisibility: 'public',
			listed: true
		});
		const relistedDeclaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			unlisted.ok === true &&
				notFound(unlistedDeclaration) &&
				unlistedAccess.value?.public === true &&
				visitorGate.canSee === false &&
				strangerSees.canSee === true &&
				relisted.ok === true &&
				relistedDeclaration.status === 200,
			'unlisted, a public group has no declaration and stays public: a signed-out visitor no longer finds it, a signed-in stranger still reads it; listed again, it is declared',
			`unlisted: declaration ${unlistedDeclaration.error ?? unlistedDeclaration.status}, access public ` +
				`${unlistedAccess.value?.public}, visitor sees ${visitorGate.canSee}, stranger sees ` +
				`${strangerSees.canSee}; listed again: declaration ${relistedDeclaration.status}`
		);

		// 20-24. the access record is the policy and the host follows it: the group is saved
		// private, public, private and public again, and each space credential is issued exactly
		// where the caller's roles or a public meta space allow.
		const visibilityNow = async () => {
			const access = await spaceRecord(groupToken, aboutSpaceUri, ACCESS_COLLECTION, 'self');
			const members = await spaceRecord(groupToken, membersSpaceUri, ACCESS_COLLECTION, 'self');
			const declared = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
			return {
				accessPublic: access.value?.public,
				declared: declared.status === 200,
				membersClosed: members.status === 200 && notPublic(members.value)
			};
		};
		const bobCredentials = async () => {
			const out = {};
			for (const [kind, space] of Object.entries({
				meta: aboutSpaceUri,
				members: membersSpaceUri
			})) {
				const asked = await spaceCredentialRequest(bobToken, space);
				out[kind] = asked.issued ? 'issued' : `${asked.status} ${asked.error ?? asked.stage}`;
			}
			return out;
		};
		const saveVisibility = async (visibility, shownVisibility, joinPolicy = 'approval') => {
			const { total: from } = await must('groupWrites', {});
			const result = await op('saveSettings', {
				callerDid: ALICE,
				visibility,
				shownVisibility,
				joinPolicy
			});
			const { writes } = await must('groupWrites', { from });
			return { result, writes };
		};
		const at = (writes, label) => writes.indexOf(label);
		const ACCESS_WRITE = `space.putRecord ${ACCESS_COLLECTION}`;
		const DECLARE = `repo.putRecord ${DECLARATION_COLLECTION}`;
		const WITHDRAW = `repo.deleteRecord ${DECLARATION_COLLECTION}`;
		const noPolicy = (writes) => writes.every((w) => !w.startsWith('simplespace.'));
		const narrowedInOrder = (writes) =>
			noPolicy(writes) &&
			at(writes, WITHDRAW) >= 0 &&
			at(writes, WITHDRAW) < at(writes, ACCESS_WRITE);
		const widenedInOrder = (writes) =>
			noPolicy(writes) &&
			at(writes, ACCESS_WRITE) >= 0 &&
			at(writes, ACCESS_WRITE) < at(writes, DECLARE);
		const issuedFor = (got, kinds) =>
			Object.keys(got).every((kind) => (got[kind] === 'issued') === kinds.includes(kind));
		const describe = (state, creds, writes) =>
			`access public ${state.accessPublic}; declared ${state.declared}; members closed ` +
			`${state.membersClosed}; ${BOB} credentials ${JSON.stringify(creds)}; writes ${writes.join(' > ') || '(none)'}`;

		// 20. saved private and invite-only: the declaration goes before the access record says
		// private, and a stranger gets no credential for either space.
		const toPrivate = await saveVisibility('private', 'public', 'invite');
		const privateState = await visibilityNow();
		const strangerCreds = await bobCredentials();
		record(
			toPrivate.result.ok === true &&
				privateState.accessPublic === false &&
				!privateState.declared &&
				privateState.membersClosed &&
				narrowedInOrder(toPrivate.writes) &&
				issuedFor(strangerCreds, []),
			'at the host: saved private, the declaration goes before the access record says private, no read policy is sent, and a stranger gets no credential for either space',
			describe(privateState, strangerCreds, toPrivate.writes)
		);

		// 21. its door is the join policy: invite-only refuses a stranger's join at the host and
		// records no request, and the gate admits the owner only.
		const strangerJoin = await tryOp('joinGroup', {
			callerDid: MALLORY,
			message: 'let me in',
			asMember: true
		});
		const requestsNow = await op('listJoinRequests', { callerDid: ALICE });
		const ownerGate = await op('gate', { did: ALICE });
		const strangerGate = await op('gate', { did: MALLORY });
		const byRecord = await op('reconcileDeclaration', { callerDid: ALICE, visibility: 'record' });
		const stillWithdrawn = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			strangerJoin.ok === false &&
				strangerJoin.error.name === 'GroupRuleError' &&
				strangerJoin.error.reason === 'invite-only' &&
				!requestsNow.some((request) => request.did === MALLORY) &&
				ownerGate.canSee === true &&
				strangerGate.canSee === false &&
				byRecord.visibility === 'private' &&
				notFound(stillWithdrawn),
			"at the host: an invite-only group refuses a stranger's join and records no request; the private group's gate admits the owner only; withdrawing by the record again is a no-op",
			`${MALLORY} join: ${strangerJoin.ok ? `ACCEPTED (${strangerJoin.value.outcome})` : `${strangerJoin.error.name} ${strangerJoin.error.reason}`}; ` +
				`gate: owner ${ownerGate.canSee}, stranger ${strangerGate.canSee}; by the record ${byRecord.visibility}`
		);

		// 22. a member of a private group gets a credential for both spaces.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const memberPrivateCreds = await bobCredentials();
		record(
			issuedFor(memberPrivateCreds, ['meta', 'members']),
			'at the host: a member admitted to a private group is issued a credential for both its spaces',
			`credentials ${JSON.stringify(memberPrivateCreds)}`
		);

		// 23. private to public to private with the member on board.
		const toPublic = await saveVisibility('public', 'private');
		const publicState = await visibilityNow();
		const memberPublicCreds = await bobCredentials();
		const backToPrivate = await saveVisibility('private', 'public', 'invite');
		const privateAgain = await visibilityNow();
		const memberPrivateAgain = await bobCredentials();
		record(
			toPublic.result.ok === true &&
				publicState.accessPublic === true &&
				publicState.declared &&
				publicState.membersClosed &&
				widenedInOrder(toPublic.writes) &&
				issuedFor(memberPublicCreds, ['meta', 'members']) &&
				backToPrivate.result.ok === true &&
				privateAgain.accessPublic === false &&
				!privateAgain.declared &&
				narrowedInOrder(backToPrivate.writes) &&
				issuedFor(memberPrivateAgain, ['meta', 'members']),
			'at the host: saved public, the access record says public before the declaration; saved private again, the declaration goes first; the member holds both credentials throughout',
			`public: ${describe(publicState, memberPublicCreds, toPublic.writes)} || private: ` +
				describe(privateAgain, memberPrivateAgain, backToPrivate.writes)
		);

		// 24. the member leaves; public again as created, a stranger gets the meta space only.
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		const leftCreds = await bobCredentials();
		const backAsCreated = await saveVisibility('public', 'private', CREATE_DATA.joinPolicy);
		const restored = await visibilityNow();
		const strangerPublicCreds = await bobCredentials();
		record(
			issuedFor(leftCreds, []) &&
				backAsCreated.result.ok === true &&
				restored.accessPublic === true &&
				restored.declared &&
				issuedFor(strangerPublicCreds, ['meta']),
			'at the host: a member who leaves a private group is refused both credentials; public again, a stranger gets a credential for the meta space only',
			`after leaving ${JSON.stringify(leftCreds)}; public again: ${describe(restored, strangerPublicCreds, backAsCreated.writes)}`
		);

		// 25. an open group admits a join at once with the host's default role, which the app
		// caches as the host gave it.
		const opened = await saveVisibility('public', 'public', 'open');
		const joined = await op('joinGroup', { callerDid: MALLORY, asMember: true });
		const herRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			MEMBERSHIP_COLLECTION,
			MALLORY
		);
		const herRow = (await op('listMembers')).find((m) => m.did === MALLORY);
		await op('leaveGroup', { callerDid: MALLORY, asMember: true });
		const herRecordAfter = await spaceRecord(
			groupToken,
			membersSpaceUri,
			MEMBERSHIP_COLLECTION,
			MALLORY
		);
		const reclosed = await saveVisibility('public', 'public', CREATE_DATA.joinPolicy);
		record(
			opened.result.ok === true &&
				joined.outcome === 'joined' &&
				JSON.stringify(herRecord.value?.roles) === JSON.stringify(['member']) &&
				herRow?.role === 'member' &&
				notFound(herRecordAfter) &&
				reclosed.result.ok === true,
			"at the host: an open group admits a join at once with the host's default role, the app caches that role, and leaving deletes the record",
			`join ${joined.outcome}; record ${JSON.stringify(herRecord.value?.roles)}; row ${herRow?.role}; ` +
				`after leaving ${herRecordAfter.error ?? herRecordAfter.status}`
		);

		// 26. the events tab reads the group's events from the index, edits included.
		const indexed = await op('listGroupEvents');
		const indexedNames = indexed.map((e) => e.value?.name);
		record(
			indexed.length === 2 &&
				indexed.every((e) => authorityOf(e.uri) === GROUP_DID) &&
				indexedNames.includes(editedName) &&
				indexedNames.includes('e2e paddle, with a cover image'),
			"the events tab reads the group's events from the index, edits included",
			`${indexed.length} indexed: ${indexedNames.join(' | ')}`
		);

		// 27. a write after the backfill is indexed at once, and a delete drops it.
		const afterBackfill = await op('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			record: eventRecord('e2e paddle, written after the index had caught up')
		});
		written.push(afterBackfill.rkey);
		const withThird = await op('listGroupEvents');
		await op('deleteGroupEvent', { callerDid: ALICE, rkey: afterBackfill.rkey });
		const afterDelete = await op('listGroupEvents');
		record(
			withThird.length === 3 &&
				withThird.some((e) => e.rkey === afterBackfill.rkey) &&
				afterDelete.length === 2 &&
				afterDelete.every((e) => e.rkey !== afterBackfill.rkey),
			'an event written after the backfill is indexed at once, and a deletion drops it',
			`after the write ${withThird.length}, after the delete ${afterDelete.length}`
		);

		// 28. the create made the calendar space for members-only events: every role reads it,
		// and nobody else.
		const calendarSpaceUri = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;
		const calendarAccess = await spaceRecord(
			groupToken,
			calendarSpaceUri,
			ACCESS_COLLECTION,
			'self'
		);
		record(
			calendarAccess.status === 200 &&
				grantsEveryRoleRead(calendarAccess.value, calendarSpaceUri) &&
				notPublic(calendarAccess.value),
			"the create made the group's calendar space, which every role reads and nobody else",
			`access ${calendarAccess.status}: ${JSON.stringify(calendarAccess.value ?? calendarAccess.error)}`
		);

		// 29. a members-only event goes into the calendar space and only there, and the index
		// never holds it.
		const membersOnly = await op('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'create',
			placement: 'members',
			record: eventRecord('e2e committee call, members only')
		});
		membersOnlyWritten.push(membersOnly.rkey);
		const inSpace = await spaceRecord(
			groupToken,
			calendarSpaceUri,
			EVENT_COLLECTION,
			membersOnly.rkey
		);
		const inRepo = await getRecord(GROUP_DID, membersOnly.rkey);
		const tab = await op('listGroupEvents');
		record(
			membersOnly.uri.startsWith(`${calendarSpaceUri}/`) &&
				inSpace.status === 200 &&
				notFound(inRepo) &&
				tab.every((e) => e.rkey !== membersOnly.rkey),
			'a members-only event is written into the calendar space and nowhere else, and the index never holds it',
			`uri ${membersOnly.uri}; space ${inSpace.status}; repo ${inRepo.error ?? inRepo.status}; index ${tab.length}`
		);

		// 30. it cannot move: an edit to public and a delete sent as public are both refused.
		const madePublic = await tryOp('writeGroupEvent', {
			callerDid: ALICE,
			intent: 'update',
			rkey: membersOnly.rkey,
			placement: 'everyone',
			record: eventRecord('e2e committee call, made public')
		});
		const wrongDelete = await tryOp('deleteGroupEvent', {
			callerDid: ALICE,
			rkey: membersOnly.rkey,
			placement: 'everyone'
		});
		const stillThere = await spaceRecord(
			groupToken,
			calendarSpaceUri,
			EVENT_COLLECTION,
			membersOnly.rkey
		);
		const stillNotPublic = await getRecord(GROUP_DID, membersOnly.rkey);
		record(
			madePublic.ok === false &&
				madePublic.error.reason === 'placement-change' &&
				wrongDelete.ok === false &&
				wrongDelete.error.reason === 'wrong-placement-delete' &&
				stillThere.value?.name === 'e2e committee call, members only' &&
				notFound(stillNotPublic),
			'a members-only event cannot be made public by an edit, or deleted as a public one',
			`edit ${madePublic.error?.reason ?? 'saved'}; delete ${wrongDelete.error?.reason ?? 'done'}; ` +
				`space ${stillThere.value?.name}; repo ${stillNotPublic.error ?? stillNotPublic.status}`
		);

		// 31. a member reads it with their own access; an outsider's and a visitor's visit read
		// nothing.
		await op('admitMember', { callerDid: ALICE, did: BOB, role: 'member' });
		const bobSlice = await op('membersOnlyEvents', { did: BOB });
		const outsiderSlice = await op('membersOnlyEvents', { did: MALLORY });
		const visitorSlice = await op('membersOnlyEvents', { did: null });
		const bobEvent = bobSlice.slice?.events.find((e) => e.rkey === membersOnly.rkey);
		record(
			bobEvent?.space === calendarSpaceUri &&
				bobSlice.slice.notice === null &&
				outsiderSlice.slice === null &&
				outsiderSlice.calls.length === 0 &&
				visitorSlice.slice === null,
			"a member reads the group's members-only events with their own access; an outsider and a visitor cause no read",
			`member ${bobSlice.slice?.events.length ?? 'none'} (notice ${bobSlice.slice?.notice}); ` +
				`outsider ${JSON.stringify(outsiderSlice.slice)} after ${outsiderSlice.calls.length} request(s); visitor ${JSON.stringify(visitorSlice.slice)}`
		);

		// 32. the member's RSVP goes into their own repo in the calendar space, citing the event's
		// current version; an answer to another version is refused; the cancel removes it.
		const stale = await op('rsvp', {
			did: BOB,
			rkey: membersOnly.rkey,
			status: 'going',
			cid: 'bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
		});
		const going = await op('rsvp', {
			did: BOB,
			rkey: membersOnly.rkey,
			status: 'going',
			cid: bobEvent?.cid ?? null
		});
		const ownGoing = await op('ownRsvp', { did: BOB, rkey: membersOnly.rkey });
		const outsiderRsvp = await op('rsvp', {
			did: MALLORY,
			rkey: membersOnly.rkey,
			status: 'going',
			cid: bobEvent?.cid ?? null
		});
		const cancelled = await op('cancelRsvp', { did: BOB, rkey: membersOnly.rkey });
		const ownAfter = await op('ownRsvp', { did: BOB, rkey: membersOnly.rkey });
		record(
			stale.ok === false &&
				stale.reason === 'changed' &&
				going.ok === true &&
				going.uri.startsWith(`${calendarSpaceUri}/${BOB}/`) &&
				ownGoing?.status === 'going' &&
				outsiderRsvp.reason === 'not-member' &&
				cancelled.ok === true &&
				ownAfter === null,
			"a member's RSVP goes into their own repo in the calendar space, citing the event's current version, and the cancel removes it",
			`stale ${stale.reason ?? 'saved'}; going ${going.ok ? going.uri : going.reason}; read back ${ownGoing?.status}; ` +
				`outsider ${outsiderRsvp.reason ?? 'saved'}; cancel ${cancelled.ok}; after ${JSON.stringify(ownAfter)}`
		);

		// 33. a member added directly is listed once their sign-in writes their acceptance, and
		// leaving deletes it.
		const addedAccepted = await op('acceptances', { viewer: ALICE, dids: [BOB] });
		const addedRoster = await op('pageRoster', { viewer: ALICE });
		await op('acceptAtSignIn', { did: BOB });
		const signedInAccepted = await op('acceptances', { viewer: ALICE, dids: [BOB] });
		const signedInRoster = await op('pageRoster', { viewer: ALICE });
		await op('leaveGroup', { callerDid: BOB, asMember: true });
		const leftAccepted = await op('acceptances', { viewer: ALICE, dids: [BOB] });
		const has = (list, did) => list.some((entry) => entry.did === did);
		record(
			addedAccepted[BOB] === false &&
				has(addedRoster.unconfirmed, BOB) &&
				!has(addedRoster.listed, BOB) &&
				signedInAccepted[BOB] === true &&
				has(signedInRoster.listed, BOB) &&
				leftAccepted[BOB] === false,
			'a member added directly is listed only once their sign-in writes their acceptance, and leaving deletes it',
			`added ${addedAccepted[BOB]} (unconfirmed ${has(addedRoster.unconfirmed, BOB)}); signed in ${signedInAccepted[BOB]} ` +
				`(listed ${has(signedInRoster.listed, BOB)}); left ${leftAccepted[BOB]}`
		);

		// 34. an open join writes the joiner's acceptance at once, and leaving deletes it.
		await saveVisibility('public', 'public', 'open');
		await op('joinGroup', { callerDid: MALLORY, asMember: true });
		const joinedAccepted = await op('acceptances', { viewer: ALICE, dids: [MALLORY] });
		await op('leaveGroup', { callerDid: MALLORY, asMember: true });
		const leftJoinAccepted = await op('acceptances', { viewer: ALICE, dids: [MALLORY] });
		await saveVisibility('public', 'public', CREATE_DATA.joinPolicy);
		record(
			joinedAccepted[MALLORY] === true && leftJoinAccepted[MALLORY] === false,
			"an open join writes the joiner's own acceptance at once, and leaving deletes it",
			`joined ${joinedAccepted[MALLORY]}; left ${leftJoinAccepted[MALLORY]}`
		);

		// 35. a member whose PDS serves no spaces stays unconfirmed, shown to admins only, and
		// nothing goes out on their session.
		const noSpacesBefore = (await op('noSpacesCalls')).length;
		await op('admitMember', { callerDid: ALICE, did: CAROL, role: 'member' });
		const carolAccepted = await op('acceptances', { viewer: ALICE, dids: [CAROL] });
		const carolRoster = await op('pageRoster', { viewer: ALICE });
		await op('ejectMember', { callerDid: ALICE, did: CAROL });
		const noSpacesAfter = (await op('noSpacesCalls')).length;
		record(
			carolAccepted[CAROL] === false &&
				has(carolRoster.unconfirmed, CAROL) &&
				!has(carolRoster.listed, CAROL) &&
				noSpacesAfter === noSpacesBefore,
			'a member whose PDS serves no spaces stays unconfirmed, shown to admins only, and nothing goes out on their session',
			`accepted ${carolAccepted[CAROL]}; unconfirmed ${has(carolRoster.unconfirmed, CAROL)}; ` +
				`requests on her session ${noSpacesAfter - noSpacesBefore}`
		);

		// 36. deleting a members-only event removes it from the calendar space.
		await op('deleteGroupEvent', {
			callerDid: ALICE,
			rkey: membersOnly.rkey,
			placement: 'members'
		});
		const goneFromSpace = await spaceRecord(
			groupToken,
			calendarSpaceUri,
			EVENT_COLLECTION,
			membersOnly.rkey
		);
		membersOnlyWritten.splice(membersOnlyWritten.indexOf(membersOnly.rkey), 1);
		record(
			notFound(goneFromSpace),
			'deleting a members-only event removes it from the calendar space',
			`after the delete ${goneFromSpace.error ?? goneFromSpace.status}`
		);
	} finally {
		// The group is left behind, so cleanup undoes only what shows outside it: its public
		// events and its declaration. A members-only event a failed run left behind goes too.
		for (const rkey of membersOnlyWritten) {
			await tryOp('deleteGroupEvent', { callerDid: ALICE, rkey, placement: 'members' }).catch(
				(error) =>
					console.log(`WARN  could not delete members-only event ${rkey}: ${error.message}`)
			);
		}
		if (written.length > 0) console.log('');
		for (const rkey of written) {
			const uri = `at://${GROUP_DID}/${EVENT_COLLECTION}/${rkey}`;
			let refusal;
			try {
				const deleted = await tryOp('deleteGroupEvent', { callerDid: ALICE, rkey });
				if (!deleted.ok) refusal = `${deleted.error.name}: ${deleted.error.message}`;
			} catch (error) {
				refusal = error.message;
			}
			const after = await getRecord(GROUP_DID, rkey);
			if (notFound(after)) note(`cleaned up ${uri}`);
			else
				console.log(
					`WARN  could not confirm ${uri} is gone: ${refusal ?? after.error ?? after.status}`
				);
		}
		if (declared && group) {
			try {
				await tryOp('reconcileDeclaration', { callerDid: ALICE, visibility: 'private' });
				const after = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
				if (notFound(after)) note('withdrew the declaration');
				else
					console.log(`WARN  ${GROUP_DID} may still be declared: ${after.error ?? after.status}`);
			} catch (error) {
				console.log(`WARN  could not withdraw the declaration: ${error.message}`);
			}
		}
		let signedOut = 0;
		for (const session of realSessions) {
			try {
				await session.signOut();
				signedOut += 1;
			} catch (error) {
				console.log(`WARN  could not sign out a session for ${session.did}: ${error.message}`);
			}
		}
		if (realSessions.length > 0)
			note(`signed out ${signedOut} of ${realSessions.length} real session(s)`);
		await signIns?.close();
		await bridge?.close();
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

// 37. no request left this machine --------------------------------------------
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

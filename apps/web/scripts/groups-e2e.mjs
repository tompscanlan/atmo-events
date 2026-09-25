#!/usr/bin/env node
/**
 * End-to-end test of groups against a live Spaces PDS. The sibling of
 * apps/api/scripts/spaces-e2e.mjs.
 *
 *   node apps/web/scripts/groups-e2e.mjs
 *
 * The checks, in order, one PASS line each:
 *   1. a group bound to an existing custodial DID has one active owner and the
 *      three seeded roles (owner 6 permissions, admin 6, member 0);
 *   2. a join under `require_approval` is a pending join_request, not a roster row;
 *   3. the owner approves, then promotes to admin, and the admin gains MANAGE_EVENTS;
 *   4. the owner's event is written to the group's repo, authored by the group DID;
 *   5. an admin edits an event they did not create, and the record stays in the
 *      group's repo with no copy in the admin's repo;
 *   6. a non-member's identical edit is refused;
 *   7. a member can leave;
 *   8. the owner cannot;
 *   9. a location with no country is written without an address entry, not refused;
 *  10. the profile and rules are read back from the about space with the group's
 *      own session;
 *  11. editing only the middle rule keeps the other two rules' URIs byte-identical;
 *  12. corrupted profile columns are rebuilt from records, and `visibility`, which
 *      no profile field owns, is left as it was;
 *  13. the roster is membership records keyed by member DID, plus the `access`
 *      record, and the app's reader agrees with the PDS;
 *  14. writing membership records leaves the space's own member list empty;
 *  15. the authz config is records (a `role` per role and two binding records),
 *      and a role's effective grant is the union of both binding records;
 * 15b. editing a binding record changes the next gate decision with no D1 write,
 *      and restoring it changes it back;
 *  16. the roster survives dropping its D1 rows, and the rebuild restores them;
 *  17. a demotion rewrites the membership record to the smaller role, the gate
 *      follows it, the join date is kept, and promoting back restores the admin;
 *  18. a DID with no membership record has no access, ejected or never a member;
 *  19. a public group is declared in its public repo, readable with no credential;
 *  20. turning the group private deletes the declaration, and turning it public
 *      again re-declares it;
 *  21. the events tab lists the group's events from the app's index, with the
 *      admin's edit from check 5;
 *  22. an event written after the index has backfilled the repo is listed at
 *      once, and deleting it removes it;
 *  23. with every row deleted except the credential, the group is rebuilt from
 *      its DID alone: row, roles, permissions and roster.
 *
 * These 24 checks (1 to 23, plus 15b) are the whole summary, so a clean run ends
 * with `SUMMARY: 24 passed, 0 failed`. Setup steps (credentials, session, bundle,
 * runtime) print as notes and are not counted.
 *
 * HOW IT RUNS. Group facts are D1 rows and a group event is an outbound PDS
 * write, so the real modules run on workerd with a real D1 binding. Vite bundles
 * scripts/groups-e2e.worker.ts (a thin JSON entry onto the $lib/groups modules
 * that holds no rules and no assertions) and Miniflare runs the bundle. Nothing
 * is reimplemented here: this file holds the steps, the assertions and the
 * read-backs. It does not use `wrangler dev` or Miniflare's proxy
 * (`getD1Database`), because both can hang in a dev container while
 * `dispatchFetch` answers. D1 lives in a temporary directory that is deleted on
 * exit, so every row a check reads was written by this run.
 *
 * Events and the declaration are read back with unauthenticated
 * `com.atproto.repo.getRecord` / `listRecords` calls, so that evidence does not
 * depend on the app, on the writer's return value, or on any credential. The
 * direct space reads (`spaceRecord`, `spaceMemberList`) go to the PDS with the
 * group's own session, not through the app's reader.
 *
 * The fixture comes from the environment:
 *   E2E_PDS            PDS that hosts the fixture group account
 *   E2E_GROUP_DID      the group account's DID
 *   E2E_GROUP_HANDLE   its handle
 *   E2E_CREDENTIALS    env file holding SPIKE_GROUP_PASSWORD, the group's app
 *                      password; defaults to $HOME/.spaces-alpha-creds.env
 * The password is stored in the scratch D1 as an encrypted `group_credentials`
 * row through the app's own `storeGroupCredential`, the same path group create
 * uses. It is never printed. A 401 from createSession means it is stale.
 *
 * Cleanup runs in the `finally`. It deletes the events, withdraws the
 * declaration, and removes the rule records, the authz config and the owner's
 * membership. It re-reads the events, the declaration, the rules and the roster
 * to confirm they are gone, and reports anything left as WARN. The profile and
 * `access` records stay at their fixed keys, and the next run overwrites them.
 * The group row lives only in the temporary D1.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_ENTRY = join(WEB_DIR, 'scripts/groups-e2e.worker.ts');

/** Read a required fixture setting, or stop before anything is written. */
function required(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set; see the header of this script`);
	return value;
}

const PDS = required('E2E_PDS');

/** The fixture's custodial group account. It is never minted here: the run
 *  binds an existing DID through `createGroup`, because `runCreateGroup` would
 *  mint a new did:plc on every run, and a did:plc is permanent. */
const GROUP_DID = required('E2E_GROUP_DID');
const GROUP_HANDLE = required('E2E_GROUP_HANDLE');
/** Owner, promoted admin, and a non-member. Humans, never write targets. */
const ALICE = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const BOB = 'did:plc:6cz6dldz42itymdbte47ewcv';
const MALLORY = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
/** Check 1's create. Kept in one place because check 23 re-creates the row
 *  from it if its rebuild fails, so the cleanup still has a row to act through. */
const CREATE_ARGS = {
	groupDid: GROUP_DID,
	ownerDid: ALICE,
	name: 'Spike groups e2e',
	description: 'Fixture group for apps/web/scripts/groups-e2e.mjs.',
	visibility: 'public'
};

const EVENT_COLLECTION = 'community.lexicon.calendar.event';
/** The group's only record in its public repo. Written out rather than
 *  imported: the check asserts what a stranger receives, and importing the
 *  app's constant would make it agree with the code by construction. */
const DECLARATION_COLLECTION = 'net.openmeet.group.declaration';

/** The seeded permission counts: owner and admin hold all six permissions, a
 *  member holds none. Written out rather than imported, because comparing the
 *  stored rows with the constant they were seeded from would only prove the
 *  seeder ran. */
const SEEDED_BUNDLE_SIZES = { owner: 6, admin: 6, member: 0 };

/** Label on the dispatched request, not a socket: see `call`. */
const ORIGIN = 'http://groups-e2e.invalid';
/** Matches apps/web/wrangler.jsonc, since the bundle is what workerd runs. */
const COMPATIBILITY_DATE = '2025-12-25';

const CREDENTIALS_PATH =
	process.env.E2E_CREDENTIALS?.trim() || join(homedir(), '.spaces-alpha-creds.env');

const results = [];

function record(ok, label, detail) {
	results.push({ ok, label, detail });
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
	return ok;
}

/** Setup progress. Not counted: the summary holds only the numbered checks. */
function note(text) {
	console.log(`      ${text}`);
}

async function loadGroupPassword() {
	const text = await readFile(CREDENTIALS_PATH, 'utf8').catch(() => '');
	for (const line of text.split('\n')) {
		const match = /^SPIKE_GROUP_PASSWORD=['"]?([^'"\s]+)['"]?$/.exec(line.trim());
		if (match) return { path: CREDENTIALS_PATH, password: match[1] };
	}
	throw new Error(`no SPIKE_GROUP_PASSWORD in ${CREDENTIALS_PATH}; set E2E_CREDENTIALS`);
}

/**
 * Fails early with a clear message if the fixture password is stale, and
 * confirms the handle resolves to the DID the group will be bound to.
 *
 * Returns the session token. The space checks use it to read the group's
 * spaces directly, not through the app's reader, so a record the app says it
 * wrote is confirmed by code that is not the app's. The members space refuses
 * anonymous reads, so these reads need the session. The group's writes still
 * go through the app's credential path inside the Worker.
 */
async function checkGroupAccount(password) {
	const response = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: GROUP_HANDLE, password })
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const hint = response.status === 401 ? ' (the fixture password is stale)' : '';
		throw new Error(
			`createSession ${GROUP_HANDLE} failed: ${response.status} ${body.error ?? ''}${hint}`
		);
	}
	if (body.did !== GROUP_DID) {
		throw new Error(`${GROUP_HANDLE} resolves to ${body.did}, not the fixture group ${GROUP_DID}`);
	}
	return body.accessJwt;
}

/** Set by startWorker; closed over by `call`. */
let miniflare;

/**
 * One operation on the real modules, inside workerd.
 *
 * `dispatchFetch` takes a URL only to populate `request.url`; ORIGIN is a host
 * that never resolves and is never connected to. Refusals come back as
 * `{ ok: false, error }`: several checks expect a refusal, so it travels as
 * data rather than as a thrown error.
 */
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

/** `call`, for the ops whose failure means the story cannot continue. */
async function must(op, args = {}) {
	const body = await call(op, args);
	if (!body.ok) {
		const stale = /\(401\)/.test(body.error.message) ? ' (the fixture password is stale)' : '';
		throw new Error(`${op} failed: ${body.error.name}: ${body.error.message}${stale}`);
	}
	return body.value;
}

/**
 * Build the Worker bundle with Vite, the same bundler the app's server build
 * uses, so the modules under test are compiled the way they ship and the `?raw`
 * migration import in $lib/groups/server/schema.ts resolves as it does in the
 * app.
 */
async function startWorker(stateDir, credentialKey) {
	const started = Date.now();
	const outDir = join(stateDir, 'bundle');
	await build({
		configFile: false,
		root: WEB_DIR,
		logLevel: 'error',
		ssr: { target: 'webworker', noExternal: true },
		build: {
			ssr: WORKER_ENTRY,
			outDir,
			emptyOutDir: true,
			minify: false,
			target: 'esnext',
			rollupOptions: { output: { entryFileNames: 'worker.js', format: 'es' } }
		}
	});

	// miniflare is not a declared dependency of apps/web; it is the runtime
	// inside the wrangler this package already depends on, so it is resolved
	// through wrangler rather than pinned twice.
	const req = createRequire(join(WEB_DIR, 'package.json'));
	const { Miniflare } = await import(createRequire(req.resolve('wrangler')).resolve('miniflare'));
	miniflare = new Miniflare({
		modules: true,
		modulesRoot: outDir,
		scriptPath: join(outDir, 'worker.js'),
		compatibilityDate: COMPATIBILITY_DATE,
		compatibilityFlags: ['nodejs_compat'],
		d1Databases: { DB: 'groups-e2e' },
		bindings: { GROUP_CREDENTIAL_KEY: credentialKey },
		defaultPersistRoot: stateDir
	});
	// Force the runtime up now, so a startup failure is reported here instead of
	// as a confusing first-request error.
	await miniflare.ready;
	const stop = () => {
		const closing = miniflare?.dispose();
		miniflare = undefined;
		return closing;
	};
	return { stop, seconds: ((Date.now() - started) / 1000).toFixed(1) };
}

/** Unauthenticated read straight from the PDS. */
async function getRecord(repo, rkey, collection = EVENT_COLLECTION) {
	const url = new URL('/xrpc/com.atproto.repo.getRecord', PDS);
	url.searchParams.set('repo', repo);
	url.searchParams.set('collection', collection);
	url.searchParams.set('rkey', rkey);
	const response = await fetch(url);
	const body = await response.json().catch(() => ({}));
	return { status: response.status, ...body };
}

async function listRecords(repo) {
	const url = new URL('/xrpc/com.atproto.repo.listRecords', PDS);
	url.searchParams.set('repo', repo);
	url.searchParams.set('collection', EVENT_COLLECTION);
	url.searchParams.set('limit', '100');
	const response = await fetch(url);
	const body = await response.json().catch(() => ({}));
	return { status: response.status, records: body.records ?? [] };
}

/** A record inside one of the group's spaces, read with the group's own
 *  session and not through the app's reader, so a record the app says it wrote
 *  is confirmed by code that shares nothing with the writer. */
async function spaceRecord(token, space, collection, rkey) {
	const url = new URL('/xrpc/com.atproto.space.getRecord', PDS);
	url.searchParams.set('space', space);
	url.searchParams.set('repo', GROUP_DID);
	url.searchParams.set('collection', collection);
	url.searchParams.set('rkey', rkey);
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	const body = await response.json().catch(() => ({}));
	return { status: response.status, ...body };
}

/** The space's own member list: the PDS's access list for the space. It is
 *  separate from our `membership` records and must stay empty (check 14).
 *  `listMembers` is owner-only, and the group is the owner. */
async function spaceMemberList(token, space) {
	const url = new URL('/xrpc/com.atproto.simplespace.listMembers', PDS);
	url.searchParams.set('space', space);
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	const body = await response.json().catch(() => ({}));
	return { status: response.status, members: body.members ?? [], error: body.error };
}

/** The `at://<authority>/...` a record actually landed under. */
function authorityOf(uri) {
	return String(uri).slice('at://'.length).split('/')[0];
}

/** What an organizer types. The record is built in the Worker by the app's own
 *  $lib/groups/event-record.ts, so nothing here builds a record by hand.
 *  `country` is what turns the typed location into an address the lexicon
 *  accepts, so every call states it, and check 9 leaves it out. */
function eventForm(name, { country, createdAt } = {}) {
	return {
		name,
		description: 'Written by apps/web/scripts/groups-e2e.mjs. Deleted in the same run.',
		startsAt: '2026-10-04T17:00:00.000Z',
		endsAt: '2026-10-04T19:00:00.000Z',
		locationName: 'Kona',
		locationCountry: country,
		createdAt
	};
}

async function main() {
	console.log('groups e2e');
	console.log(`  pds     ${PDS}`);
	console.log(`  group   ${GROUP_HANDLE} (${GROUP_DID})`);
	console.log(`  humans  owner ${ALICE}, admin ${BOB}, non-member ${MALLORY}`);
	console.log('');

	const { path, password } = await loadGroupPassword();
	note(`fixture credentials loaded from ${path}`);
	const groupToken = await checkGroupAccount(password);
	note(`${GROUP_HANDLE} authenticates as ${GROUP_DID}`);
	// The wrapping key is per-run and lives only in this process: the scratch D1
	// is thrown away with stateDir, so nothing outlives the run that could
	// decrypt the row it writes.
	const credentialKey = Buffer.from(randomBytes(32)).toString('base64');

	const stateDir = await mkdtemp(join(tmpdir(), 'groups-e2e-'));
	let worker;
	let group;
	const written = [];
	/** Set once the spaces exist, so the `finally` knows to empty them. */
	let spacesProvisioned = false;
	let membersSpaceUri;
	let aboutSpaceUri;
	/** Set once the group has been declared, so the `finally` withdraws it. A
	 *  leftover declaration would announce a fixture group to the network. */
	let declared = false;
	try {
		worker = await startWorker(stateDir, credentialKey);
		note(`worker bundled and ready in ${worker.seconds}s (workerd, empty D1 under ${stateDir})`);
		console.log('');

		await must('storeCredential', {
			groupDid: GROUP_DID,
			service: PDS,
			identifier: GROUP_HANDLE,
			password
		});
		// A mint records where the group's repo lives. This run does not mint, so
		// it records that here. The indexer resolves a DID's PDS from that row
		// first; without it the index would resolve the DID over the public
		// network.
		await must('registerIdentity', { groupDid: GROUP_DID, handle: GROUP_HANDLE, pds: PDS });
		note(`${GROUP_DID} registered with the index as a repo on ${PDS}`);
		// 1. create ------------------------------------------------------------
		group = await must('createGroup', CREATE_ARGS);
		const members = await must('listMembers', { groupId: group.id });
		const bundles = await must('rolePermissions', { groupId: group.id });
		const sizes = Object.fromEntries(Object.entries(bundles).map(([r, p]) => [r, p.length]));
		const owners = members.filter((m) => m.role === 'owner' && m.status === 'active');
		const seededBundles =
			Object.keys(sizes).length === Object.keys(SEEDED_BUNDLE_SIZES).length &&
			Object.entries(SEEDED_BUNDLE_SIZES).every(([role, n]) => sizes[role] === n);
		record(
			group.group_did === GROUP_DID &&
				members.length === 1 &&
				owners.length === 1 &&
				owners[0].did === ALICE &&
				seededBundles,
			'group bound to the custodial DID, one active owner, three pared role bundles',
			`${group.name} on ${group.group_did}, roster ${members.length} (${owners.length} active owner: ${owners[0]?.did}), ` +
				Object.entries(sizes)
					.map(([role, n]) => `${role} ${n}`)
					.join(' / ')
		);

		// 2. join under require_approval ---------------------------------------
		const join = await must('requestJoin', { groupId: group.id, did: BOB, message: 'hello' });
		const pendingBob = await must('membership', {
			groupId: group.id,
			did: BOB,
			probe: ['CREATE_EVENT', 'MANAGE_EVENTS']
		});
		const requests = await must('listJoinRequests', { groupId: group.id });
		record(
			group.require_approval === 1 &&
				join.outcome === 'pending' &&
				pendingBob.role === null &&
				pendingBob.status === null &&
				pendingBob.permissions.length === 0 &&
				requests.length === 1 &&
				requests[0].did === BOB &&
				requests[0].status === 'pending',
			'join under require_approval is PENDING, not on the roster',
			`outcome ${join.outcome}; roster row ${pendingBob.role ?? 'none'}/${pendingBob.status ?? 'none'}; ` +
				`join_request ${requests[0]?.id} ${requests[0]?.status}`
		);

		// 3. approve, then promote ---------------------------------------------
		await must('approveJoinRequest', {
			groupId: group.id,
			requestId: requests[0].id,
			deciderDid: ALICE,
			role: 'member'
		});
		const asMember = await must('membership', {
			groupId: group.id,
			did: BOB,
			probe: ['MANAGE_EVENTS']
		});
		await must('changeMemberRole', { groupId: group.id, did: BOB, role: 'admin' });
		const asAdmin = await must('membership', {
			groupId: group.id,
			did: BOB,
			probe: ['MANAGE_EVENTS', 'CREATE_EVENT']
		});
		record(
			asMember.role === 'member' &&
				asMember.status === 'active' &&
				asMember.can.MANAGE_EVENTS === false &&
				asAdmin.role === 'admin' &&
				asAdmin.can.MANAGE_EVENTS === true,
			'approved, then promoted to admin — MANAGE_EVENTS follows the role',
			`member: MANAGE_EVENTS ${asMember.can.MANAGE_EVENTS}; admin: MANAGE_EVENTS ${asAdmin.can.MANAGE_EVENTS}, ` +
				`${asAdmin.permissions.length} permissions resolved`
		);

		// 4. the owner's event is the group's record ----------------------------
		const created = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			form: eventForm('Kona sunrise paddle', { country: 'US' })
		});
		written.push(created.rkey);
		const asPersisted = await getRecord(GROUP_DID, created.rkey);
		const inOwnersRepo = await getRecord(ALICE, created.rkey);
		const address = asPersisted.value?.locations?.[0];
		record(
			asPersisted.status === 200 &&
				authorityOf(asPersisted.uri) === GROUP_DID &&
				asPersisted.value?.name === 'Kona sunrise paddle' &&
				address?.$type === 'community.lexicon.location.address' &&
				address?.country === 'US' &&
				inOwnersRepo.status !== 200,
			"owner's event is authored by the GROUP DID, not by the owner",
			`read back ${asPersisted.uri} (cid ${asPersisted.cid}); author ${authorityOf(asPersisted.uri)}; ` +
				`location ${address?.name}/${address?.country}; ` +
				`same rkey in the owner's repo: ${inOwnersRepo.status === 200 ? 'PRESENT' : (inOwnersRepo.error ?? inOwnersRepo.status)}`
		);

		// 5. an admin edits an event they did not create -------------------------
		// Admins co-edit through the group's credential, so the author must not
		// change. Checked by reading the record back from the PDS, never from the
		// writer's return value.
		const editedName = 'Kona sunrise paddle (rescheduled by admin bob)';
		const edited = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: BOB,
			intent: 'update',
			rkey: created.rkey,
			form: eventForm(editedName, { country: 'US', createdAt: asPersisted.value?.createdAt })
		});
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
				inAdminsRepo.status !== 200 &&
				adminsEvents.status === 200 &&
				adminsCopies.length === 0,
			'admin edits an event they did not create; the author is still the GROUP DID',
			`edit landed as "${afterEdit.value?.name}" at ${afterEdit.uri} (cid ${asPersisted.cid} -> ${afterEdit.cid}); ` +
				`author ${authorityOf(afterEdit.uri)}, not the editing admin ${BOB}; ` +
				`admin's own repo: ${inAdminsRepo.error ?? inAdminsRepo.status} for that rkey, ` +
				`${adminsCopies.length} copies among ${adminsEvents.records.length} ${EVENT_COLLECTION} record(s)`
		);

		// 6. a non-member tries the same edit ------------------------------------
		const refused = await call('writeGroupEvent', {
			groupId: group.id,
			callerDid: MALLORY,
			intent: 'update',
			rkey: created.rkey,
			form: eventForm('Kona sunrise paddle (hijacked)', { country: 'US' })
		});
		const afterRefusal = await getRecord(GROUP_DID, created.rkey);
		record(
			refused.ok === false &&
				refused.error.name === 'GroupPermissionError' &&
				refused.error.permission === 'MANAGE_EVENTS' &&
				afterRefusal.cid === afterEdit.cid &&
				afterRefusal.value?.name === editedName,
			"non-member's identical edit is refused",
			`${refused.error?.name}: ${refused.error?.message}; record unchanged at cid ${afterRefusal.cid}`
		);

		// 7. self-service leave ---------------------------------------------------
		const left = await call('removeMember', { groupId: group.id, did: BOB });
		const afterLeave = await must('membership', { groupId: group.id, did: BOB, probe: [] });
		const rosterAfterLeave = await must('listMembers', { groupId: group.id });
		record(
			left.ok === true &&
				afterLeave.role === null &&
				afterLeave.status === null &&
				rosterAfterLeave.every((m) => m.did !== BOB),
			'a member can leave',
			`roster ${rosterAfterLeave.length} row(s) (${rosterAfterLeave.map((m) => m.role).join(', ')}); ` +
				`${BOB} membership: ${afterLeave.role ?? 'none'}`
		);

		// 8. the owner cannot -----------------------------------------------------
		const ownerLeave = await call('removeMember', { groupId: group.id, did: ALICE });
		const rosterAfterOwner = await must('listMembers', { groupId: group.id });
		const ownerStill = rosterAfterOwner.find((m) => m.did === ALICE);
		record(
			ownerLeave.ok === false &&
				ownerLeave.error.name === 'GroupRuleError' &&
				ownerLeave.error.reason === 'owner-protected' &&
				ownerStill?.role === 'owner' &&
				ownerStill?.status === 'active',
			'the owner cannot leave',
			`${ownerLeave.error?.name}(${ownerLeave.error?.reason}): ${ownerLeave.error?.message}; ` +
				`owner still ${ownerStill?.role}/${ownerStill?.status}`
		);

		// 9. the address rule --------------------------------------------------------
		// The address lexicon requires `country` (2 to 10 characters), so an
		// address with an empty country makes the write gate reject the whole
		// record. A location with no country is not an address: the event must
		// still be written, without one.
		const noCountry = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			form: eventForm('Kona paddle, location typed without a country')
		});
		written.push(noCountry.rkey);
		const persistedNoCountry = await getRecord(GROUP_DID, noCountry.rkey);
		record(
			persistedNoCountry.status === 200 &&
				authorityOf(persistedNoCountry.uri) === GROUP_DID &&
				persistedNoCountry.value?.locations === undefined &&
				persistedNoCountry.value?.name === 'Kona paddle, location typed without a country',
			'a location with no country is written WITHOUT an address entry, not refused',
			`${persistedNoCountry.uri} (cid ${persistedNoCountry.cid}); locations: ` +
				`${persistedNoCountry.value?.locations === undefined ? 'absent' : JSON.stringify(persistedNoCountry.value.locations)}`
		);

		// 10. the group's public face, as records --------------------------------
		// `createGroup` provisions nothing, so both spaces are made here. Then the
		// profile and rules are written through the same gate as the events, and
		// read back with the group's own session. No unit test can prove that
		// read: the com.atproto.space.* parameter names and the space-scoped URI
		// form are defined by the PDS, not by us.
		const spaces = await must('provisionSpaces', { groupId: group.id });
		note(`about space   ${spaces.aboutSpaceUri}`);
		note(`members space ${spaces.membersSpaceUri}`);
		membersSpaceUri = spaces.membersSpaceUri;
		aboutSpaceUri = spaces.aboutSpaceUri;
		spacesProvisioned = true;
		// The fixture DID is reused and its spaces are idempotent, so a previous
		// run can leave an authz config behind. Start from "no config yet".
		// Otherwise the gate reads that config, and the owner, whose membership
		// record the last cleanup dropped, holds nothing.
		const stale = await must('dropAuthz', { groupId: group.id });
		if (stale.dropped.length) note(`reset a leftover authz config (${stale.dropped.join(', ')})`);

		await must('writeGroupProfile', {
			groupId: group.id,
			callerDid: ALICE,
			name: 'Spike groups e2e, from records',
			description: 'Written into the about space, not a column.',
			locationName: 'Kailua-Kona'
		});
		await must('setGroupRules', {
			groupId: group.id,
			callerDid: ALICE,
			rules: 'Be kind\nNo spam\nStay on topic'
		});
		const about = await must('readGroupAbout', { groupId: group.id });
		record(
			about.profile?.name === 'Spike groups e2e, from records' &&
				about.profile?.locationName === 'Kailua-Kona' &&
				// Derived from the row (require_approval = 1, public), never the form.
				about.profile?.joinPolicy === 'approval' &&
				about.rules.map((rule) => rule.text).join('|') === 'Be kind|No spam|Stay on topic',
			'profile + rules read back out of the about space with the group’s own session',
			`joinPolicy ${about.profile?.joinPolicy}; ${about.rules.length} rule(s); ` +
				`first rule ${about.rules[0]?.uri}`
		);

		// 11. a rule's citation survives an edit to another rule ------------------
		// Change only the middle rule. A writer that deleted and rewrote the list
		// would pass check 10 and fail here, and would break every citation of a
		// rule the group had handed out. That is why this is its own check.
		const urisBefore = about.rules.map((rule) => rule.uri);
		const secondRules = await must('setGroupRules', {
			groupId: group.id,
			callerDid: ALICE,
			rules: 'Be kind\nNo self-promotion\nStay on topic'
		});
		const afterEditAbout = await must('readGroupAbout', { groupId: group.id });
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
		// Corrupt every column the profile owns, rebuild from records, and check
		// the row came back, while `visibility`, which no profile field owns, is
		// left exactly as it was.
		await must('corruptGroupCache', { groupId: group.id });
		const rebuilt = await must('rebuildGroupCache', { groupId: group.id });
		record(
			rebuilt.outcome === 'repaired' &&
				rebuilt.row.name === 'Spike groups e2e, from records' &&
				rebuilt.row.description === 'Written into the about space, not a column.' &&
				rebuilt.row.location_name === 'Kailua-Kona' &&
				rebuilt.row.require_approval === 1 &&
				// Untouched: no profile field owns visibility, so a rebuild must not
				// guess one from the join policy it can read.
				rebuilt.row.visibility === group.visibility,
			'a corrupted cache rebuilds from records, and leaves what no record owns alone',
			`name "${rebuilt.row.name}"; visibility ${rebuilt.row.visibility} (was ${group.visibility}); ` +
				`${rebuilt.rules} rule record(s)`
		);

		// 13. the roster is records ------------------------------------------------
		// The owner's membership and the access record are written the way the
		// create path writes them; BOB is admitted and promoted through the roster
		// acts the app's own handlers call. Then all of it is read back, first
		// through the app's reader, then straight from the PDS with the group's own
		// session. That proves the records are really there and that a DID is a
		// usable record key.
		await must('writeGroupAccess', { groupId: group.id, callerDid: ALICE });
		await must('putMembership', {
			groupId: group.id,
			callerDid: ALICE,
			did: ALICE,
			roles: ['owner']
		});
		await must('admitMember', { groupId: group.id, callerDid: ALICE, did: BOB, role: 'member' });
		await must('promoteMember', { groupId: group.id, callerDid: ALICE, did: BOB, role: 'admin' });

		const recorded = await must('recordedRoster', { groupId: group.id, did: BOB });
		const bobsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.membership',
			BOB
		);
		const accessRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.access',
			'self'
		);
		record(
			recorded.source === 'records' &&
				recorded.roster.map((entry) => `${entry.did}/${entry.role}`).join(' ') ===
					`${ALICE}/owner ${BOB}/admin` &&
				recorded.hasAccess === true &&
				// Keyed by the member DID, and the app's reader agrees with the PDS.
				bobsRecord.status === 200 &&
				bobsRecord.value?.subject === BOB &&
				JSON.stringify(bobsRecord.value?.roles) === JSON.stringify(['admin']) &&
				accessRecord.status === 200 &&
				JSON.stringify(accessRecord.value?.roles) === JSON.stringify(['owner', 'admin', 'member']),
			'the roster is membership records in the members space, keyed by member DID',
			`source ${recorded.source}; ${recorded.roster.length} member(s) ` +
				`(${recorded.roster.map((e) => e.role).join(', ')}); ` +
				`${BOB} read straight off the PDS at rkey=${BOB} as ${JSON.stringify(bobsRecord.value?.roles)}; ` +
				`access record roles ${JSON.stringify(accessRecord.value?.roles)}`
		);

		// 14. the space's own member list stays empty ------------------------------
		// A DID on that list could read the whole members space straight from the
		// PDS with its own credential (every membership, every role, every
		// permission binding), bypassing the app's roster gate. Writing a
		// membership record must never add one.
		const memberList = await spaceMemberList(groupToken, membersSpaceUri);
		record(
			memberList.status === 200 && memberList.members.length === 0,
			'writing membership records leaves the members space’s own member list empty',
			`listMembers ${memberList.status}: ${memberList.members.length} entr(ies)` +
				`${memberList.error ? ` (${memberList.error})` : ''}; ` +
				`the app stays the space's only reader`
		);

		// 15. the authz config is records ------------------------------------------
		// One `role` record per seeded role, plus the two binding records: the
		// four community actions under the standard's identifiers, the two event
		// actions under ours. Read back twice: through the app's reader, which
		// translates them into our permission names, and straight from the PDS,
		// which proves the wire form uses the published identifiers and not our
		// spellings. The effective grant is the union of the two records, which a
		// reader of only `permissions` gets wrong.
		await must('writeGroupAuthz', { groupId: group.id, callerDid: ALICE });
		const authz = await must('recordedAuthz', { groupId: group.id, role: 'admin' });
		const permissionsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.permissions',
			'self'
		);
		const eventPermissionsRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.eventPermissions',
			'self'
		);
		const adminRoleRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.role',
			'admin'
		);
		const communityActions = (permissionsRecord.value?.bindings ?? []).find(
			(binding) => binding.role === 'admin'
		)?.actions;
		const modalityActions = (eventPermissionsRecord.value?.bindings ?? []).find(
			(binding) => binding.role === 'admin'
		)?.actions;
		record(
			authz.hasAuthz === true &&
				authz.roles.join(',') === 'owner,admin,member' &&
				adminRoleRecord.status === 200 &&
				adminRoleRecord.value?.id === 'admin' &&
				// The wire carries the standard's identifiers, not MANAGE_GROUP.
				JSON.stringify(communityActions) ===
					JSON.stringify(['community.configure', 'admit', 'eject', 'role.assign']) &&
				JSON.stringify(modalityActions) === JSON.stringify(['manageEvents', 'createEvent']) &&
				// And the union spans both records: an admin who may configure the
				// group but may not create its events is the failure mode.
				authz.effective.permissions.join(',') ===
					'ADMIT_MEMBERS,ASSIGN_ROLES,CREATE_EVENT,EJECT_MEMBERS,MANAGE_EVENTS,MANAGE_GROUP',
			'roles and both binding records are in the members space, and a grant is their union',
			`roles [${authz.roles.join(', ')}]; permissions ${JSON.stringify(communityActions)}; ` +
				`eventPermissions ${JSON.stringify(modalityActions)}; ` +
				`admin resolves to ${authz.effective.permissions.length} permission(s)`
		);

		// 15b. the gate follows the records ----------------------------------------
		// Edit one binding record on the PDS (admin loses CREATE_EVENT in
		// `eventPermissions`) and ask the gate again. BOB's D1 row still says admin
		// and `role_permissions` still grants admin CREATE_EVENT, so a gate that
		// read rows would not change its answer. Then restore the seeded
		// permissions and check that the answer changes back.
		const probe = ['CREATE_EVENT', 'MANAGE_EVENTS'];
		const bobBefore = await must('membership', { groupId: group.id, did: BOB, probe });
		await must('writeGroupAuthz', {
			groupId: group.id,
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
		const bobEdited = await must('membership', { groupId: group.id, did: BOB, probe });
		const editedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.eventPermissions',
			'self'
		);
		await must('writeGroupAuthz', { groupId: group.id, callerDid: ALICE });
		const bobRestored = await must('membership', { groupId: group.id, did: BOB, probe });
		const bobRowRole = (await must('listMembers', { groupId: group.id })).find(
			(m) => m.did === BOB
		)?.role;
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
		// The owner's row cannot be dropped (the `memberships_owner_undeletable`
		// trigger refuses to delete it while the group exists), so this drops every
		// other row and rebuilds them from records.
		const dropped = await must('dropMembershipRows', { groupId: group.id });
		const rosterWhileDropped = await must('recordedRoster', { groupId: group.id, did: BOB });
		const rebuiltMembers = await must('rebuildGroupMembers', { groupId: group.id });
		record(
			dropped.dropped === 1 &&
				// The page still renders the full roster with the rows gone, because
				// the records are the source.
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
		// Taking a role away writes the smaller record before the row, so a
		// failure between the two leaves the record granting less. The order is
		// tested with a failing writer in `server/roster.test.ts`. Only a live run
		// shows that the record the PDS returns is the smaller one, that the gate
		// (which reads records) follows it, and that the join date is kept.
		// Promoting back is a grant, and leaves check 18 an admin to eject.
		const joinedAt = recorded.memberships.find((m) => m.subject === BOB)?.createdAt;
		const rosterProbe = ['EJECT_MEMBERS', 'CREATE_EVENT'];
		await must('promoteMember', { groupId: group.id, callerDid: ALICE, did: BOB, role: 'member' });
		const demotedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.membership',
			BOB
		);
		const demoted = await must('membership', { groupId: group.id, did: BOB, probe: rosterProbe });
		await must('promoteMember', { groupId: group.id, callerDid: ALICE, did: BOB, role: 'admin' });
		const repromoted = await must('membership', {
			groupId: group.id,
			did: BOB,
			probe: rosterProbe
		});
		record(
			demotedRecord.status === 200 &&
				JSON.stringify(demotedRecord.value?.roles) === JSON.stringify(['member']) &&
				demotedRecord.value?.createdAt === joinedAt &&
				demoted.role === 'member' &&
				// `member`'s seeded bundle is empty: membership is what it holds.
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
		// An eject deletes the record, and a DID that never had one gets the same
		// answer: the records, not the rows, decide access.
		await must('ejectMember', { groupId: group.id, callerDid: ALICE, did: BOB });
		const afterEject = await must('recordedRoster', { groupId: group.id, did: BOB });
		const strangerCheck = await must('recordedRoster', { groupId: group.id, did: MALLORY });
		const ejectedRecord = await spaceRecord(
			groupToken,
			membersSpaceUri,
			'net.openmeet.group.membership',
			BOB
		);
		record(
			ejectedRecord.status !== 200 &&
				afterEject.hasAccess === false &&
				strangerCheck.hasAccess === false &&
				afterEject.roster.map((entry) => entry.did).join(',') === ALICE,
			'a DID with no membership record has no access, whether ejected or never a member',
			`${BOB} after eject: record ${ejectedRecord.error ?? ejectedRecord.status}, access ` +
				`${afterEject.hasAccess}; never-a-member ${MALLORY}: access ${strangerCheck.hasAccess}; ` +
				`roster ${afterEject.roster.length}`
		);

		// 19. the declaration: the record that lets other apps discover the group --
		// The group is announced to the network by a record in its public repo,
		// and the assertion is an unauthenticated fetch of exactly the bytes a
		// peer app would get. Asserted on the raw JSON rather than through our own
		// parser, which would only prove we agree with ourselves.
		await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'public'
		});
		declared = true;
		const declaration = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			declaration.status === 200 &&
				declaration.value?.aboutSpace === aboutSpaceUri &&
				typeof declaration.value?.createdAt === 'string' &&
				// "Discovery only": nothing here may let a stranger render the
				// group's name, because the about space refuses them anyway.
				Object.keys(declaration.value ?? {})
					.sort()
					.join(',') === '$type,aboutSpace,createdAt',
			'a public group is DECLARED in its public repo, readable with no credential',
			`anonymous getRecord ${declaration.status}; points at ${declaration.value?.aboutSpace}; ` +
				`fields ${Object.keys(declaration.value ?? {}).join(', ')}`
		);

		// 20. and turning private withdraws it --------------------------------------
		// A group that stops being discoverable must stop being announced, so the
		// declaration is deleted rather than left pointing at a space nobody may
		// read. A missing declaration is the only signal a private group gives.
		// Visibility is flipped through the app's own updater, so the branch comes
		// from the row.
		await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'private'
		});
		const withdrawn = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'public'
		});
		const redeclared = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			withdrawn.status !== 200 && redeclared.status === 200,
			'turning a group private DELETES its declaration; turning it back re-declares it',
			`private: ${withdrawn.error ?? withdrawn.status}; public again: ${redeclared.status}`
		);

		// 21. the events tab's list comes from the index, not the PDS -------------
		// The tab reads the app's own index, the way every other actor's events are
		// read, rather than the group's repo over HTTP. This is that read, through
		// the app's own function. It must contain both events written above, with
		// the admin's edit applied.
		const indexed = await must('listGroupEvents', { groupId: group.id });
		const indexedNames = indexed.map((e) => e.value?.name);
		record(
			indexed.length === 2 &&
				indexed.every((e) => authorityOf(e.uri) === GROUP_DID) &&
				indexedNames.includes(editedName) &&
				indexedNames.includes('Kona paddle, location typed without a country') &&
				!indexedNames.includes('Kona sunrise paddle'),
			"the events tab reads the group's events from the index, edits included",
			`${indexed.length} indexed record(s), all authored by ${GROUP_DID}: ${indexedNames.join(' | ')}`
		);

		// 22. and a write after that read still shows up ---------------------------
		// An actor-scoped query backfills a repo once and then records that it is
		// done, so check 21 would pass on the backfill alone even if every later
		// write were invisible. This writes a third event after that backfill,
		// re-reads with no cron tick and no waiting, then deletes it and re-reads
		// again. Only the write gate telling the index about each write explains
		// either result.
		const afterBackfill = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			form: eventForm('Kona paddle, written after the index had caught up')
		});
		written.push(afterBackfill.rkey);
		const withThird = await must('listGroupEvents', { groupId: group.id });
		await must('deleteGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			rkey: afterBackfill.rkey
		});
		const afterDelete = await must('listGroupEvents', { groupId: group.id });
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
		// Delete every row the group has except its credential, rebuild keyed by
		// the DID, and the group comes back. Last, because it replaces the row the
		// checks above act through. The unit tests cannot show the live half: the
		// real space reader's records restoring the row, and the declaration
		// probe, through the group's own session, reading this group as declared
		// and so public.
		const profileNow = await must('readGroupAbout', { groupId: group.id });
		const rosterNow = await must('recordedRoster', { groupId: group.id });
		const beforeDrop = await must('groupSnapshot', { groupDid: GROUP_DID });
		const wiped = await must('dropGroupRows', { groupId: group.id });
		let restored;
		try {
			restored = await must('rebuildGroup', { groupDid: GROUP_DID });
		} finally {
			// The cleanup below acts through a row, so it gets the restored one, or
			// failing that a fresh one bound to the same DID and spaces.
			if (restored) group = restored.group;
			else {
				group = await must('createGroup', CREATE_ARGS);
				await must('provisionSpaces', { groupId: group.id });
			}
		}
		const afterRebuild = await must('groupSnapshot', { groupDid: GROUP_DID });
		// The row's surrogate id and cache timestamp are regenerated, and its
		// creation date comes from the profile, which this fixture wrote after the
		// row. Every other column must match exactly.
		const columnsOf = (snap) => {
			const rest = { ...snap.row };
			for (const key of ['id', 'created_at', 'updated_at']) delete rest[key];
			return JSON.stringify(rest);
		};
		const rosterOf = (snap) => snap.roster.map((m) => `${m.did}/${m.role}/${m.status}`).join(' ');
		const recordJoinedAt = Object.fromEntries(
			rosterNow.roster.map((entry) => [entry.did, entry.created_at])
		);
		const sameColumns = columnsOf(afterRebuild) === columnsOf(beforeDrop);
		const sameGrants = JSON.stringify(afterRebuild.grants) === JSON.stringify(beforeDrop.grants);
		record(
			wiped.left === null &&
				restored?.path === 'restored' &&
				afterRebuild.row.visibility === 'public' &&
				sameColumns &&
				afterRebuild.row.created_at === Date.parse(profileNow.profile.createdAt) &&
				rosterOf(afterRebuild) === rosterOf(beforeDrop) &&
				afterRebuild.roster.every((m) => m.created_at === recordJoinedAt[m.did]) &&
				sameGrants,
			'the group, deleted down to its credential, is rebuilt from its DID alone',
			`path ${restored?.path}; visibility ${afterRebuild.row.visibility} (declared); ` +
				`columns ${sameColumns ? 'identical' : 'DIFFER'}; roster ${rosterOf(afterRebuild)}; ` +
				`${afterRebuild.grants.length} role grant row(s) ${sameGrants ? 'identical' : 'DIFFER'}`
		);
	} finally {
		if (written.length > 0) console.log('');
		for (const rkey of written) {
			const uri = `at://${GROUP_DID}/${EVENT_COLLECTION}/${rkey}`;
			let refusal;
			try {
				const deleted = await call('deleteGroupEvent', {
					groupId: group.id,
					callerDid: ALICE,
					rkey
				});
				if (!deleted.ok) refusal = `${deleted.error.name}: ${deleted.error.message}`;
			} catch (error) {
				refusal = error.message;
			}
			// The record decides whether the fixture is clean, not the delete call.
			const after = await getRecord(GROUP_DID, rkey);
			if (after.status === 200) {
				console.log(`WARN  could not clean up ${uri}: ${refusal ?? 'still readable'}`);
			} else {
				note(`cleaned up ${uri} (${after.error ?? after.status})`);
			}
		}
		// The declaration matters most: a leftover one keeps announcing a fixture
		// group to the network. It is withdrawn by the app's own path (flip to
		// private) and confirmed gone by an anonymous read, never by the delete's
		// return value.
		if (declared) {
			try {
				await call('reconcileDeclaration', {
					groupId: group.id,
					callerDid: ALICE,
					visibility: 'private'
				});
				const after = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
				if (after.status === 200) {
					console.log(`WARN  ${GROUP_DID} is still declared to the network`);
				} else {
					note(`withdrew the declaration (${after.error ?? after.status})`);
				}
			} catch (error) {
				console.log(`WARN  could not withdraw the declaration: ${error.message}`);
			}
		}
		// The space records, cleaned up the same way the events are: emptied
		// through the app, then re-read to check the space really is empty again.
		// Before the worker stops, because this goes through it.
		if (spacesProvisioned) {
			try {
				await call('setGroupRules', { groupId: group.id, callerDid: ALICE, rules: '' });
				const leftover = await call('readGroupAbout', { groupId: group.id });
				const remaining = leftover.ok ? leftover.value.rules.length : -1;
				if (remaining === 0) {
					note('cleaned up the about space rule records (profile left at self)');
				} else {
					console.log(`WARN  ${remaining} rule record(s) left in the about space`);
				}
			} catch (error) {
				console.log(`WARN  could not clean up the about space: ${error.message}`);
			}
			try {
				// The authz config first: dropping the owner's membership while a
				// config remains leaves a space in which the owner holds nothing,
				// and the next run's first gated write is refused.
				const authz = await call('dropAuthz', { groupId: group.id });
				if (authz.ok) note(`dropped the authz config (${authz.value.dropped.length} record(s))`);
				else console.log(`WARN  could not drop the authz config: ${authz.error.message}`);
				// No roster act removes the owner's membership (the owner cannot be
				// ejected), so it is dropped directly, the same way it was written.
				await call('dropMembership', { groupId: group.id, callerDid: ALICE, did: ALICE });
				const leftover = await call('recordedRoster', { groupId: group.id });
				const remaining = leftover.ok ? leftover.value.memberships.length : -1;
				if (remaining === 0) {
					note(
						'cleaned up the members space membership records (the access record is ' +
							'left at its fixed key, which a re-run overwrites)'
					);
				} else {
					console.log(`WARN  ${remaining} membership record(s) left in the members space`);
				}
			} catch (error) {
				console.log(`WARN  could not clean up the members space: ${error.message}`);
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

const passed = results.filter((entry) => entry.ok).length;
const failed = results.length - passed;
console.log('');
console.log(`SUMMARY: ${passed} passed, ${failed} failed`);
if (failed > 0 && failure?.stack) console.error(failure.stack);
process.exit(failed > 0 ? 1 : 0);

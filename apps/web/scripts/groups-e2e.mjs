#!/usr/bin/env node
/**
 * End-to-end proof of the GROUP half of openmeet-atmo against the live Spaces
 * PDS fixture (https://pds.opnmt.net) — the sibling of
 * apps/api/scripts/spaces-e2e.mjs.
 *
 *   node apps/web/scripts/groups-e2e.mjs
 *
 * What it proves, in order, one PASS line each:
 *   1. a group bound to an EXISTING custodial DID is created with exactly one
 *      active owner membership and the three seeded roles, each with its pared
 *      bundle (owner 6 / admin 6 / member 0 — a member holds nothing, because
 *      membership itself is what a member holds);
 *   2. a join under `require_approval` lands as a PENDING join_request and NOT
 *      on the roster;
 *   3. the owner approves, then promotes to admin, and the promoted member's
 *      effective permissions gain MANAGE_EVENTS;
 *   4. the owner creates a group event and the record persisted on the live PDS
 *      is authored by the GROUP DID, not by the owner;
 *   5. THE LOAD-BEARING ONE — an admin who did not create that event edits it,
 *      the edit lands, and the record is STILL in the group's repo, with no
 *      copy in the admin's own repo. Legacy openmeet ships admin co-editing by
 *      writing as the admin; this model co-edits by custody, so the author must
 *      not move. Asserted by reading the record back from the PDS, never from
 *      the writer's return value;
 *   6. a non-member's identical edit is refused;
 *   7. a member can leave;
 *   8. the owner cannot; and
 *   9. a location typed with no country is written WITHOUT an address entry
 *      rather than refused — the regression guard for the bug this script
 *      found on the live fixture: the route used to send `country: ''`, which
 *      the address lexicon (country 2..10) refuses, so the write gate rejected
 *      EVERY group event carrying a location name. Fixed in
 *      $lib/groups/event-record.ts, which both the route and this proof build
 *      their records with;
 *  10. the group's public face is READ BACK out of its about space with the
 *      group's own session — `profile` at `self` plus one `rule` record per
 *      rule. This is the half no unit test can prove: the
 *      `com.atproto.space.*` parameter names and the space-scoped URI form
 *      belong to the live PDS, not to us (FR-004, FR-007);
 *  11. THE OTHER LOAD-BEARING ONE — only the MIDDLE rule's text is changed,
 *      and the first and third rules come back with byte-identical URIs. A
 *      writer that deleted and re-created the list would pass check 10 and
 *      fail this one, while invalidating every citation the group ever handed
 *      out (FR-004c, SC-011); and
 *  12. every column the profile owns is corrupted through the app's own
 *      updater, rebuilt from records, and comes back — while `visibility` and
 *      `status`, which no record owns yet, are left exactly as they were
 *      (FR-004b, FR-009, SC-002 mode 1).
 *
 * Those twelve ARE the summary: setup lines (credentials, fixture session,
 * bundle, runtime) print as notes and are deliberately not counted, so
 * `SUMMARY: 12 passed, 0 failed` maps one-to-one onto the story above.
 *
 * How it runs. Group facts are D1 rows and a group event is an outbound PDS
 * write, i.e. Worker code, so the real modules run ON workerd with a real D1
 * binding: Vite bundles scripts/groups-e2e.worker.ts (a JSON door onto
 * $lib/groups/{event-record,permissions}.ts and
 * $lib/groups/server/{repo,event-writer}.ts — it owns no rule and no
 * assertion) and Miniflare runs the bundle. Nothing is
 * reimplemented here; this file supplies the story, the assertions and the
 * read-backs. NOT `wrangler dev`, and not Miniflare's magic proxy
 * (`getD1Database`) either: both hang in this dev container, while
 * `dispatchFetch` answers. D1 is a scratch directory that is deleted on exit,
 * so every row this run asserts on is a row this run wrote.
 *
 * Every read-back is an UNAUTHENTICATED `com.atproto.repo.getRecord` /
 * `listRecords` against the live PDS, so the authorship evidence does not
 * depend on the app, on the writer's return value, or on any credential.
 *
 * Credentials: the group account's app password is read from
 * $HOME/.spaces-alpha-creds.env (written by infra/spaces-alpha/seed.sh) and
 * seeded into the scratch D1 as an ENCRYPTED `group_credentials` row through
 * the app's own `storeGroupCredential` — the same and only path production
 * uses since `om-dnwi7` deleted the operator secret. It is never printed. A
 * 401 from createSession means the fixture passwords are stale: re-run
 * `infra/spaces-alpha/seed.sh --apply --reset-passwords`.
 *
 * Cleanup: every record written here is deleted from the group's repo in the
 * `finally`, verified gone by a fresh read, and anything left behind is
 * reported as WARN. The group itself lives only in the scratch D1.
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

const PDS = process.env.GROUPS_E2E_PDS ?? 'https://pds.opnmt.net';

/** The dev fixture's custodial group account. NEVER minted here — v1 binds an
 *  existing DID (see $lib/groups/server/credentials.ts, AUTO_MINT_GROUP_DID). */
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const GROUP_HANDLE = 'spike-group.opnmt.net';
/** Owner, promoted admin, and a non-member. Humans, never write targets. */
const ALICE = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const BOB = 'did:plc:6cz6dldz42itymdbte47ewcv';
const MALLORY = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

const EVENT_COLLECTION = 'community.lexicon.calendar.event';
const GROUP_SLUG = 'spike-groups-e2e';

/** The pared seed, as literals (FR-005a/FR-005c): owner and admin hold the six
 *  enforced names, a member holds none. Written out rather than imported,
 *  because comparing the STORED rows against the constant they were seeded
 *  from would only prove the seeder ran. */
const SEEDED_BUNDLE_SIZES = { owner: 6, admin: 6, member: 0 };

/** Label on the dispatched request, not a socket: see `call`. */
const ORIGIN = 'http://openmeet-atmo-groups-e2e.invalid';
/** Matches apps/web/wrangler.jsonc, since the bundle is what workerd runs. */
const COMPATIBILITY_DATE = '2025-12-25';

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

/** Setup progress. Not a check: the eight checks are the story, so they are the
 *  whole summary. */
function note(text) {
	console.log(`      ${text}`);
}

async function loadGroupPassword() {
	for (const path of CREDENTIAL_PATHS) {
		let text;
		try {
			text = await readFile(path, 'utf8');
		} catch {
			continue;
		}
		for (const line of text.split('\n')) {
			const match = /^SPIKE_GROUP_PASSWORD=['"]?([^'"\s]+)['"]?$/.exec(line.trim());
			if (match) return { path, password: match[1] };
		}
	}
	throw new Error(
		`no SPIKE_GROUP_PASSWORD in ${CREDENTIAL_PATHS.join(' or ')}; run infra/spaces-alpha/seed.sh --apply --reset-passwords`
	);
}

/**
 * Fail fast and legibly if the fixture password is stale, and confirm the
 * handle really is the DID this group will be bound to. The session token is
 * not used for anything else: the group write goes through the app's own
 * credential path inside the Worker.
 */
async function checkGroupAccount(password) {
	const response = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ identifier: GROUP_HANDLE, password })
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const hint =
			response.status === 401
				? ' (stale fixture credentials: re-run seed.sh --apply --reset-passwords)'
				: '';
		throw new Error(
			`createSession ${GROUP_HANDLE} failed: ${response.status} ${body.error ?? ''}${hint}`
		);
	}
	if (body.did !== GROUP_DID) {
		throw new Error(`${GROUP_HANDLE} resolves to ${body.did}, not the fixture group ${GROUP_DID}`);
	}
}

/** Set by startWorker; closed over by `call`. */
let miniflare;

/**
 * One operation on the real modules, inside workerd.
 *
 * `dispatchFetch` takes a URL only to populate `request.url`; ORIGIN is a host
 * that never resolves and is never connected to. Refusals come back as
 * `{ ok: false, error }` — they are the expected outcome of three of the eight
 * checks, so they travel as data rather than as a thrown string.
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
		const stale = /\(401\)/.test(body.error.message)
			? ' (stale fixture credentials: re-run seed.sh --apply --reset-passwords)'
			: '';
		throw new Error(`${op} failed: ${body.error.name}: ${body.error.message}${stale}`);
	}
	return body.value;
}

/**
 * Build the Worker bundle with Vite — the same bundler the app's own server
 * build uses — so the modules under test are compiled the way they ship, and
 * the `?raw` migration import in $lib/groups/server/schema.ts resolves the way
 * it does in the app.
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
		d1Databases: { DB: 'openmeet-atmo-groups-e2e' },
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

/** Unauthenticated read straight off the live PDS. */
async function getRecord(repo, rkey) {
	const url = new URL('/xrpc/com.atproto.repo.getRecord', PDS);
	url.searchParams.set('repo', repo);
	url.searchParams.set('collection', EVENT_COLLECTION);
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

/** The `at://<authority>/...` a record actually landed under. */
function authorityOf(uri) {
	return String(uri).slice('at://'.length).split('/')[0];
}

/** What an organizer types. The RECORD is built in the Worker by the app's own
 *  $lib/groups/event-record.ts, so nothing here hand-rolls a record shape.
 *  `country` is the variable under test — it is what turns the typed location
 *  into an address the lexicon accepts — so every call states it, and check 9
 *  states its absence. */
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
	console.log('openmeet-atmo groups e2e');
	console.log(`  pds     ${PDS}`);
	console.log(`  group   ${GROUP_HANDLE} (${GROUP_DID})`);
	console.log(`  humans  owner ${ALICE}, admin ${BOB}, non-member ${MALLORY}`);
	console.log('');

	const { path, password } = await loadGroupPassword();
	note(`fixture credentials loaded from ${path}`);
	await checkGroupAccount(password);
	note(`${GROUP_HANDLE} authenticates as ${GROUP_DID}`);
	// The wrapping key is per-run and lives only in this process: the scratch D1
	// is thrown away with stateDir, so nothing outlives the run that could
	// decrypt the row it writes.
	const credentialKey = Buffer.from(randomBytes(32)).toString('base64');

	const stateDir = await mkdtemp(join(tmpdir(), 'openmeet-atmo-groups-e2e-'));
	let worker;
	let group;
	const written = [];
	/** Set once the about space exists, so the `finally` knows to empty it. */
	let aboutProvisioned = false;
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
		// 1. create ------------------------------------------------------------
		group = await must('createGroup', {
			groupDid: GROUP_DID,
			ownerDid: ALICE,
			name: 'Spike groups e2e',
			slug: GROUP_SLUG,
			description: 'Fixture group for apps/web/scripts/groups-e2e.mjs.',
			status: 'published',
			visibility: 'public'
		});
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
			`${group.slug} on ${group.group_did}, roster ${members.length} (${owners.length} active owner: ${owners[0]?.did}), ` +
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

		// 9. the address rule, as a regression guard ------------------------------
		// Until this run, this submission was REFUSED: the route sent
		// `country: ''` and the write gate's validator rejected the whole record,
		// so every group event carrying a location name failed. A location with no
		// country is not an address; the event must still be written, without one.
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
		// The read is the point. `createGroup` provisions nothing, so the space is
		// made here; then profile + rules are written through the same gate the
		// events went through, and read back with the GROUP's own session. That
		// read is what FR-007 claims and what no unit test can prove: the
		// com.atproto.space.* parameter names and the space-scoped URI form are
		// the live PDS's, not ours.
		const spaces = await must('provisionAboutSpace', { groupId: group.id });
		note(`about space ${spaces.aboutSpaceUri}`);
		aboutProvisioned = true;

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

		// 11. SC-011 — a citation survives an edit --------------------------------
		// Change only the MIDDLE rule. A writer that deleted and rewrote the list
		// would pass step 10 and fail here, which is the whole reason this is its
		// own check rather than an assertion inside the last one.
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
			'editing one rule leaves the other two rules’ URIs byte-identical (SC-011)',
			`kept ${secondRules.kept.length}, created ${secondRules.created.length}, ` +
				`deleted ${secondRules.deleted.length}; rule 1 ${urisBefore[0] === urisAfter[0] ? 'unchanged' : 'MOVED'}`
		);

		// 12. the cache is a cache ------------------------------------------------
		// Corrupt every column the profile owns, rebuild from records, and check
		// the row came back — while `visibility` and `status`, which no record
		// owns, are left exactly as they were. (SC-002 mode 1, FR-004b.)
		await must('corruptGroupCache', { groupId: group.id });
		const rebuilt = await must('rebuildGroupCache', { groupId: group.id });
		record(
			rebuilt.outcome === 'repaired' &&
				rebuilt.row.name === 'Spike groups e2e, from records' &&
				rebuilt.row.description === 'Written into the about space, not a column.' &&
				rebuilt.row.location_name === 'Kailua-Kona' &&
				rebuilt.row.require_approval === 1 &&
				// Untouched: no record owns these yet, so a rebuild must not guess.
				rebuilt.row.visibility === group.visibility &&
				rebuilt.row.status === group.status,
			'a corrupted cache rebuilds from records, and leaves what no record owns alone',
			`name "${rebuilt.row.name}"; visibility ${rebuilt.row.visibility} (was ${group.visibility}); ` +
				`status ${rebuilt.row.status}; ${rebuilt.rules} rule record(s)`
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
		// The about-space records, cleaned up the same way the events are: by
		// emptying the rules list and asserting the space really is empty again.
		// Before the worker stops, because this goes through it.
		if (aboutProvisioned) {
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

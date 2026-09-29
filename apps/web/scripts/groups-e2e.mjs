#!/usr/bin/env node
/**
 * End-to-end test of groups against a live PDS that supports Spaces.
 *
 *   node apps/web/scripts/groups-e2e.mjs
 *
 * It runs 26 numbered checks (1 to 23, plus 15b, 20b and 20c), prints one PASS
 * or FAIL line each, and a clean run ends with `SUMMARY: 26 passed, 0 failed`.
 * Setup steps print as notes and are not counted. In order: create and the
 * seeded roles (1), join, approval and promotion (2-3), events written as the
 * group DID and the edit gate (4-6), leaving (7-8), a cover image uploaded
 * into the group's repo (9), the profile and rules in the about space (10-12), the roster and authz
 * config as records in the members space (13-18), the discovery declaration and
 * visibility at the host (19-20c), the events index (21-22), and a rebuild of
 * the whole group from its DID (23).
 *
 * Not covered: a member reading a private group's profile with their own
 * credential. This run holds only the group's credential.
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
 *   E2E_PDS            PDS that hosts the group account
 *   E2E_GROUP_DID      the group account's DID
 *   E2E_GROUP_HANDLE   its handle
 *   E2E_GROUP_PASSWORD the group's app password, or
 *   E2E_CREDENTIALS    an env file that holds E2E_GROUP_PASSWORD
 *   E2E_OWNER_DID      the person who owns the group
 *   E2E_ADMIN_DID      a person who joins and is promoted to admin
 *   E2E_OUTSIDER_DID   a person who is never a member
 * The password goes into the temporary D1 through the app's own
 * `storeGroupCredential` and is never printed. A 401 from createSession means it
 * is stale.
 *
 * Cleanup runs in the `finally`. It deletes the events, withdraws the
 * declaration, and removes the rules, the authz config and the owner's
 * membership. Then it re-reads each one and prints WARN for anything left. The
 * profile and `access` records stay at fixed keys that the next run overwrites.
 */
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
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

/** An existing group account, bound through `createGroup`. Minting one with
 *  `runCreateGroup` would leave a new, permanent did:plc behind on every run. */
const GROUP_DID = required('E2E_GROUP_DID');
const GROUP_HANDLE = required('E2E_GROUP_HANDLE');
/** The owner, a member promoted to admin, and a non-member. The run never writes
 *  to their repos. */
const ALICE = required('E2E_OWNER_DID');
const BOB = required('E2E_ADMIN_DID');
const MALLORY = required('E2E_OUTSIDER_DID');
/** Check 1's create, reused by check 23 if its rebuild fails. */
const CREATE_ARGS = {
	groupDid: GROUP_DID,
	ownerDid: ALICE,
	name: 'groups e2e',
	description: 'Fixture group for apps/web/scripts/groups-e2e.mjs.'
};

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

const EVENT_COLLECTION = 'community.lexicon.calendar.event';
/** The record in the group's public repo that lets other apps find it. */
const DECLARATION_COLLECTION = 'net.openmeet.group.declaration';

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

async function loadGroupPassword() {
	const direct = process.env.E2E_GROUP_PASSWORD?.trim();
	if (direct) return { path: 'E2E_GROUP_PASSWORD', password: direct };
	if (!CREDENTIALS_PATH)
		throw new Error('set E2E_GROUP_PASSWORD, or E2E_CREDENTIALS to a file that holds it');
	const text = await readFile(CREDENTIALS_PATH, 'utf8').catch(() => '');
	for (const line of text.split('\n')) {
		const match = /^E2E_GROUP_PASSWORD=['"]?([^'"\s]+)['"]?$/.exec(line.trim());
		if (match) return { path: CREDENTIALS_PATH, password: match[1] };
	}
	throw new Error(`no E2E_GROUP_PASSWORD in ${CREDENTIALS_PATH}`);
}

/**
 * Fails early if the password is stale or the handle does not resolve to
 * GROUP_DID. Returns the session token for the direct space reads. The group's
 * writes still go through the app's credential path inside the Worker.
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

/** Bundles the Worker with Vite, like the app's server build, so the modules
 *  compile the way they ship and the `?raw` migration import in schema.ts works. */
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

	// miniflare is not a direct dependency. It is resolved through wrangler, which
	// ships it, so it is not pinned twice.
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

/** A record in one of the group's spaces, read with the group's session and not
 *  through the app's reader, so the check shares no code with the writer. */
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

/** A space's read policy as the host reports it. */
async function spaceReadPolicy(token, space) {
	const url = new URL('/xrpc/com.atproto.simplespace.getSpace', PDS);
	url.searchParams.set('space', space);
	const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	const body = await response.json().catch(() => ({}));
	return { status: response.status, readPolicy: body.readPolicy?.$type ?? null, error: body.error };
}

/** The PDS's own member list for a space, separate from our `membership`
 *  records. `listMembers` is owner-only, and the group is the owner. */
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
	// A per-run key that lives only in this process, so nothing that outlives the
	// run can decrypt the credential row.
	const credentialKey = Buffer.from(randomBytes(32)).toString('base64');

	const stateDir = await mkdtemp(join(tmpdir(), 'groups-e2e-'));
	let worker;
	let group;
	const written = [];
	/** Set once the spaces exist, so the `finally` knows to empty them. */
	let spacesProvisioned = false;
	let membersSpaceUri;
	let aboutSpaceUri;
	/** Set once the group is declared, so the `finally` withdraws it. */
	let declared = false;
	/** Set while the about space may be private, so the `finally` makes it public. */
	let hostPrivate = false;
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
		// A mint records where the group's repo lives, and the index looks there
		// first. This run does not mint, so it records it here.
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
		const join = await must('requestJoin', {
			groupId: group.id,
			did: BOB,
			message: 'hello',
			visibility: CREATE_VISIBILITY
		});
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
			'approved, then promoted to admin, and MANAGE_EVENTS follows the role',
			`member: MANAGE_EVENTS ${asMember.can.MANAGE_EVENTS}; admin: MANAGE_EVENTS ${asAdmin.can.MANAGE_EVENTS}, ` +
				`${asAdmin.permissions.length} permissions resolved`
		);

		// 4. the owner's event is the group's record ----------------------------
		const created = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
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

		// 5. an admin edits an event they did not create -------------------------
		// Admins edit through the group's credential, so the author must not change.
		const editedName = 'e2e sunrise paddle (rescheduled by admin bob)';
		const edited = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: BOB,
			intent: 'update',
			rkey: created.rkey,
			record: eventRecord(editedName, { country: 'US', createdAt: asPersisted.value?.createdAt })
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
				notFound(inAdminsRepo) &&
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
			record: eventRecord('e2e sunrise paddle (hijacked)', { country: 'US' })
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

		// 9. a cover image -----------------------------------------------------------
		// The editor uploads the image first, into the group's repo, then cites it
		// in the record. The PDS serves the blob only once a record cites it.
		const image = await must('uploadGroupEventImage', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			bytes: PNG_1PX,
			mimeType: 'image/png'
		});
		const withImage = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			record: eventRecord('e2e paddle, with a cover image', { country: 'US', image })
		});
		written.push(withImage.rkey);
		const persistedWithImage = await getRecord(GROUP_DID, withImage.rkey);
		const cited = persistedWithImage.value?.media?.[0]?.content?.ref?.$link;
		const blobUrl = new URL('/xrpc/com.atproto.sync.getBlob', PDS);
		blobUrl.searchParams.set('did', GROUP_DID);
		blobUrl.searchParams.set('cid', String(cited));
		const blob = await fetch(blobUrl);
		record(
			persistedWithImage.status === 200 &&
				authorityOf(persistedWithImage.uri) === GROUP_DID &&
				cited === image?.ref?.$link &&
				blob.ok,
			"an event's cover image is uploaded into the GROUP repo, and its record cites it",
			`${persistedWithImage.uri} cites ${cited}; uploaded ${image?.ref?.$link}; ` +
				`getBlob from the group's repo: ${blob.status}`
		);

		// 10. the group's public face, as records --------------------------------
		// `createGroup` provisions nothing, so both spaces are made here. Only a live
		// PDS can prove the profile and rules read back, because the PDS defines the
		// com.atproto.space.* parameters and the space URI form.
		const spaces = await must('provisionSpaces', {
			groupId: group.id,
			visibility: CREATE_VISIBILITY
		});
		note(`about space   ${spaces.aboutSpaceUri}`);
		note(`members space ${spaces.membersSpaceUri}`);
		membersSpaceUri = spaces.membersSpaceUri;
		aboutSpaceUri = spaces.aboutSpaceUri;
		spacesProvisioned = true;
		// Drop any authz config a previous run left (see dropAuthz in the worker).
		const stale = await must('dropAuthz', { groupId: group.id });
		if (stale.dropped.length) note(`reset a leftover authz config (${stale.dropped.join(', ')})`);
		// An existing space keeps its old read policy, so set this run's choice and
		// read it back. The policy provisioning left is logged first, because the set
		// would hide a new space provisioned with the wrong one.
		const provisionedPolicy = await spaceReadPolicy(groupToken, aboutSpaceUri);
		note(
			`about space read policy as provisioning left it: ${provisionedPolicy.readPolicy ?? provisionedPolicy.error ?? provisionedPolicy.status}`
		);
		await must('setReadPolicy', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: CREATE_VISIBILITY
		});
		const startPolicy = await spaceReadPolicy(groupToken, aboutSpaceUri);
		if (startPolicy.readPolicy !== READ_POLICY[CREATE_VISIBILITY]) {
			throw new Error(
				`the about space reads back ${startPolicy.readPolicy ?? startPolicy.error ?? startPolicy.status}, not ${READ_POLICY[CREATE_VISIBILITY]}`
			);
		}
		note(`about space read policy ${startPolicy.readPolicy}`);

		await must('writeGroupProfile', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: CREATE_VISIBILITY,
			name: 'groups e2e, from records',
			description: 'Written into the about space, not a column.',
			locationName: 'e2e group place'
		});
		await must('setGroupRules', {
			groupId: group.id,
			callerDid: ALICE,
			rules: 'Be kind\nNo spam\nStay on topic'
		});
		const about = await must('readGroupAbout', { groupId: group.id });
		record(
			about.profile?.name === 'groups e2e, from records' &&
				about.profile?.locationName === 'e2e group place' &&
				// From the visibility and require_approval, never from the form.
				about.profile?.joinPolicy === 'approval' &&
				about.rules.map((rule) => rule.text).join('|') === 'Be kind|No spam|Stay on topic',
			'profile + rules read back out of the about space with the group’s own session',
			`joinPolicy ${about.profile?.joinPolicy}; ${about.rules.length} rule(s); ` +
				`first rule ${about.rules[0]?.uri}`
		);

		// 11. a rule's citation survives an edit to another rule ------------------
		// A writer that rewrote the whole list would pass check 10 and still break
		// every existing citation of a rule.
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
		// The row has no visibility column, so a rebuild has nothing to guess.
		await must('corruptGroupCache', { groupId: group.id });
		const rebuilt = await must('rebuildGroupCache', { groupId: group.id });
		record(
			rebuilt.outcome === 'repaired' &&
				rebuilt.row.name === 'groups e2e, from records' &&
				rebuilt.row.description === 'Written into the about space, not a column.' &&
				rebuilt.row.location_name === 'e2e group place' &&
				rebuilt.row.require_approval === 1 &&
				!('visibility' in rebuilt.row),
			'a corrupted cache rebuilds from records, and the row carries no visibility',
			`name "${rebuilt.row.name}"; row columns ${Object.keys(rebuilt.row).length}; ` +
				`${rebuilt.rules} rule record(s)`
		);

		// 13. the roster is records ------------------------------------------------
		// Read back through the app's reader and straight from the PDS. That proves
		// the records exist and that a DID works as a record key.
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
		// A DID on this list could read the whole members space from the PDS with
		// its own credential, bypassing the app's roster gate.
		const memberList = await spaceMemberList(groupToken, membersSpaceUri);
		record(
			memberList.status === 200 && memberList.members.length === 0,
			'writing membership records leaves the members space’s own member list empty',
			`listMembers ${memberList.status}: ${memberList.members.length} entr(ies)` +
				`${memberList.error ? ` (${memberList.error})` : ''}; ` +
				`the app stays the space's only reader`
		);

		// 15. the authz config is records ------------------------------------------
		// Read through the app's reader, which maps actions to our permission names,
		// and straight from the PDS, which shows the wire form uses the standard's
		// action identifiers. A role's grant is the union of both binding records.
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
				JSON.stringify(communityActions) ===
					JSON.stringify(['community.configure', 'admit', 'eject', 'role.assign']) &&
				JSON.stringify(modalityActions) === JSON.stringify(['manageEvents', 'createEvent']) &&
				authz.effective.permissions.join(',') ===
					'ADMIT_MEMBERS,ASSIGN_ROLES,CREATE_EVENT,EJECT_MEMBERS,MANAGE_EVENTS,MANAGE_GROUP',
			'roles and both binding records are in the members space, and a grant is their union',
			`roles [${authz.roles.join(', ')}]; permissions ${JSON.stringify(communityActions)}; ` +
				`eventPermissions ${JSON.stringify(modalityActions)}; ` +
				`admin resolves to ${authz.effective.permissions.length} permission(s)`
		);

		// 15b. the gate follows the records ----------------------------------------
		// Take CREATE_EVENT from admin in the `eventPermissions` record only. The D1
		// rows still grant it, so only a gate that reads the records changes its answer.
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
		// A trigger protects the owner's row, so only the other rows are dropped.
		const dropped = await must('dropMembershipRows', { groupId: group.id });
		const rosterWhileDropped = await must('recordedRoster', { groupId: group.id, did: BOB });
		const rebuiltMembers = await must('rebuildGroupMembers', { groupId: group.id });
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
			notFound(ejectedRecord) &&
				afterEject.hasAccess === false &&
				strangerCheck.hasAccess === false &&
				afterEject.roster.map((entry) => entry.did).join(',') === ALICE,
			'a DID with no membership record has no access, whether ejected or never a member',
			`${BOB} after eject: record ${ejectedRecord.error ?? ejectedRecord.status}, access ` +
				`${afterEject.hasAccess}; never-a-member ${MALLORY}: access ${strangerCheck.hasAccess}; ` +
				`roster ${afterEject.roster.length}`
		);

		// 19. the declaration: the record that lets other apps discover the group --
		// Asserted on the raw JSON an anonymous peer app gets, not through our parser.
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
				// Discovery only: nothing that shows a stranger the group's name.
				Object.keys(declaration.value ?? {})
					.sort()
					.join(',') === '$type,aboutSpace,createdAt',
			'a public group is DECLARED in its public repo, readable with no credential',
			`anonymous getRecord ${declaration.status}; points at ${declaration.value?.aboutSpace}; ` +
				`fields ${Object.keys(declaration.value ?? {}).join(', ')}`
		);

		// 20. and turning private withdraws it --------------------------------------
		// A private group must not be announced, so its declaration is deleted. The
		// visibility is passed in, as the settings save passes the form's choice.
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
			notFound(withdrawn) && redeclared.status === 200,
			'turning a group private DELETES its declaration; turning it back re-declares it',
			`private: ${withdrawn.error ?? withdrawn.status}; public again: ${redeclared.status}`
		);

		// 20b. private at the host ----------------------------------------------
		// Here the group is made private at the host, through the settings save's
		// call, and the declaration follows the host's answer. The second reconcile
		// re-sends the withdrawal, which must be a no-op at the PDS.
		hostPrivate = true;
		await must('setReadPolicy', { groupId: group.id, callerDid: ALICE, visibility: 'private' });
		const privatePolicy = await spaceReadPolicy(groupToken, aboutSpaceUri);
		const aligned = await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'host'
		});
		const withdrawnAtHost = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		const realigned = await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'host'
		});
		const stillWithdrawn = await getRecord(GROUP_DID, 'self', DECLARATION_COLLECTION);
		record(
			privatePolicy.readPolicy === READ_POLICY.private &&
				aligned.visibility === 'private' &&
				realigned.visibility === 'private' &&
				notFound(withdrawnAtHost) &&
				notFound(stillWithdrawn),
			'a group made private at its host reads back member-list, its declaration is withdrawn, and withdrawing it again is a no-op',
			`getSpace ${privatePolicy.readPolicy ?? privatePolicy.error ?? privatePolicy.status}; ` +
				`declaration ${withdrawnAtHost.error ?? withdrawnAtHost.status}, then ` +
				`${stillWithdrawn.error ?? stillWithdrawn.status} after a repeated withdrawal`
		);

		// 20c. and its door is shut to strangers ---------------------------------
		// The join is passed no visibility, so it asks the host. Then the host goes
		// back to public and the app must read it so. Every read above answered
		// private, so this shows the app tells the two apart.
		const strangerJoin = await call('joinGroup', {
			groupId: group.id,
			callerDid: MALLORY,
			message: 'let me in'
		});
		const requestsNow = await must('listJoinRequests', { groupId: group.id, status: 'all' });
		const ownerGate = await must('gate', { groupId: group.id, did: ALICE });
		const strangerGate = await must('gate', { groupId: group.id, did: MALLORY });
		await must('setReadPolicy', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: CREATE_VISIBILITY
		});
		const backPolicy = await spaceReadPolicy(groupToken, aboutSpaceUri);
		const backAligned = await must('reconcileDeclaration', {
			groupId: group.id,
			callerDid: ALICE,
			visibility: 'host'
		});
		if (backPolicy.readPolicy === READ_POLICY.public) hostPrivate = false;
		record(
			!strangerJoin.ok &&
				strangerJoin.error.reason === 'invite-only' &&
				!requestsNow.some((request) => request.did === MALLORY) &&
				ownerGate.visibility === 'private' &&
				ownerGate.canSee === true &&
				strangerGate.canSee === false &&
				backPolicy.readPolicy === READ_POLICY.public &&
				backAligned.visibility === 'public',
			"a private group refuses a stranger's join and records no request; its gate admits the owner only; set back to public, the app reads it as public",
			`${MALLORY} join: ${strangerJoin.ok ? `ACCEPTED (${strangerJoin.value.outcome})` : strangerJoin.error.reason}; ` +
				`requests from them ${requestsNow.filter((request) => request.did === MALLORY).length}; ` +
				`gate: owner ${ownerGate.canSee}, stranger ${strangerGate.canSee} (host ${ownerGate.visibility}); ` +
				`back: getSpace ${backPolicy.readPolicy ?? backPolicy.error ?? backPolicy.status}, app reads ${backAligned.visibility}`
		);

		// 21. the events tab's list comes from the index, not the PDS -------------
		// The tab reads the app's index, like any other account's events, and not the
		// group's repo.
		const indexed = await must('listGroupEvents', { groupId: group.id });
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
		const afterBackfill = await must('writeGroupEvent', {
			groupId: group.id,
			callerDid: ALICE,
			intent: 'create',
			record: eventRecord('e2e paddle, written after the index had caught up')
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
		// Last, because it replaces the row the checks above act through. Nothing is
		// restored for visibility, which stays at the host.
		const profileNow = await must('readGroupAbout', { groupId: group.id });
		const rosterNow = await must('recordedRoster', { groupId: group.id });
		const beforeDrop = await must('groupSnapshot', { groupDid: GROUP_DID });
		const wiped = await must('dropGroupRows', { groupId: group.id });
		let restored;
		try {
			restored = await must('rebuildGroup', { groupDid: GROUP_DID });
		} finally {
			// Cleanup needs a row: the restored one, or else a fresh one on the same DID.
			if (restored) group = restored.group;
			else {
				group = await must('createGroup', CREATE_ARGS);
				await must('provisionSpaces', { groupId: group.id, visibility: CREATE_VISIBILITY });
			}
		}
		const afterRebuild = await must('groupSnapshot', { groupDid: GROUP_DID });
		// id and updated_at are regenerated, and created_at comes from the profile.
		// Every other column must match exactly.
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
			const after = await getRecord(GROUP_DID, rkey);
			if (notFound(after)) {
				note(`cleaned up ${uri} (${after.error})`);
			} else {
				console.log(
					`WARN  could not confirm ${uri} is gone: ${refusal ?? after.error ?? after.status}`
				);
			}
		}
		// A leftover declaration would keep announcing a test group to the network.
		if (declared) {
			try {
				await call('reconcileDeclaration', {
					groupId: group.id,
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
		if (spacesProvisioned && hostPrivate) {
			// Before the owner's membership is dropped below, while the owner may still
			// change the policy.
			try {
				const reset = await call('setReadPolicy', {
					groupId: group.id,
					callerDid: ALICE,
					visibility: CREATE_VISIBILITY
				});
				const policy = await spaceReadPolicy(groupToken, aboutSpaceUri);
				if (reset.ok && policy.readPolicy === READ_POLICY[CREATE_VISIBILITY]) {
					note(`put the about space back to ${policy.readPolicy}`);
				} else {
					console.log(
						`WARN  the about space may still be private: ${reset.ok ? policy.readPolicy : reset.error.message}`
					);
				}
			} catch (error) {
				console.log(`WARN  could not reset the about space read policy: ${error.message}`);
			}
		}
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
				// The authz config goes first. See dropAuthz in the worker.
				const authz = await call('dropAuthz', { groupId: group.id });
				if (authz.ok) note(`dropped the authz config (${authz.value.dropped.length} record(s))`);
				else console.log(`WARN  could not drop the authz config: ${authz.error.message}`);
				// No roster act removes the owner, so the record is dropped directly.
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

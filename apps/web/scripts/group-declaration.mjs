#!/usr/bin/env node
/**
 * IS EACH GROUP ANNOUNCED EXACTLY WHEN IT SHOULD BE? Checked against a running
 * deployment, with no credential.
 *
 *   node apps/web/scripts/group-declaration.mjs [origin] [group ...]
 *   node apps/web/scripts/group-declaration.mjs https://atmo.testnet.openmeet.net
 *   node apps/web/scripts/group-declaration.mjs https://atmo.testnet.openmeet.net sdf-ac-fans.group.opnmt.net
 *
 * A group is a DID or a full handle. With none named, every group the origin's
 * /groups page links to is checked, which is every group it shows to strangers.
 *
 * WHY THIS EXISTS. A public group announces itself with one record in its
 * PUBLIC repo — the declaration — and a private group must not. That record is
 * the whole of cross-app discovery: a peer app that has never heard of us finds
 * our groups through it and nothing else. groups-e2e.mjs check 19 proves the
 * writer against a fixture group. This proves the DEPLOYMENT: the groups a real
 * origin actually serves, which is where a group created before the writer
 * existed, or a flip the writer never saw, would show up. (SC-001, FR-003.)
 *
 * THE ORIGIN IS THE AUTHORITY ON VISIBILITY, read the way a stranger reads it:
 * an anonymous GET of /groups/<did>. 200 is a public group, 404 is a private one
 * (or not a group here at all). Then the declaration is fetched from the group's
 * own PDS, found through its DID document, and must agree:
 *
 *   public  -> the declaration exists, is exactly $type + aboutSpace + createdAt,
 *              and points at THIS DID's about space;
 *   private -> RecordNotFound. A declaration here announces a group whose
 *              owner chose not to be found, so it FAILS.
 *
 * WHAT "THE POINTER RESOLVES" CAN MEAN WITH NO CREDENTIAL. The pointer is
 * checked to be the deterministic address of this group's own about space, and
 * the PDS is checked to serve spaces at all. Whether the space EXISTS cannot be
 * seen from outside: the alpha PDS answers an anonymous describeSpace with 401
 * AuthMissing for a real space and a made-up one alike (measured 2026-09-24).
 * That is the protocol's choice, not a gap in this script.
 *
 * AND THE ORIGIN'S OWN INDEX MUST AGREE. The origin indexes every declaration
 * off Jetstream (rsvp.atmo.declaration.listRecords), which is what a browse list
 * built from declarations would read. A public group must be listed there and a
 * private one must not. The list is read UNSCOPED on purpose: an `actor`
 * parameter makes contrail backfill that repo on demand, which would pass
 * without Jetstream ever carrying the record. The index trails the repo by up to
 * one cron tick, so a failure within a minute of a flip means re-run, not broken.
 *
 * Anonymous and read-only: no login, no PDS write. Safe against any deployment.
 */
const args = process.argv.slice(2);
const origin = (
	args[0]?.startsWith('http') ? args.shift() : 'https://atmo.testnet.openmeet.net'
).replace(/\/$/, '');

const COLLECTION = 'net.openmeet.group.declaration';
const ABOUT_SPACE_TYPE = 'net.openmeet.space.about';

let passed = 0;
let failed = 0;

const pass = (what) => {
	passed += 1;
	console.log(`PASS  ${what}`);
};
const fail = (what, detail) => {
	failed += 1;
	console.log(`FAIL  ${what}\n      ${detail}`);
};
const note = (what) => console.log(`note  ${what}`);

async function json(url) {
	const res = await fetch(url);
	return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function resolveDid(group) {
	if (group.startsWith('did:')) return group;
	const res = await fetch(`https://${group}/.well-known/atproto-did`);
	const text = (await res.text()).trim();
	if (res.status !== 200 || !text.startsWith('did:')) {
		throw new Error(`handle ${group} did not resolve (${res.status})`);
	}
	return text;
}

async function pdsOf(did) {
	const docUrl = did.startsWith('did:plc:')
		? `https://plc.directory/${did}`
		: `https://${did.slice('did:web:'.length)}/.well-known/did.json`;
	const { status, body } = await json(docUrl);
	const pds = body.service?.find((s) => s.id === '#atproto_pds' || s.id === `${did}#atproto_pds`);
	if (status !== 200 || !pds) throw new Error(`no PDS in the DID document (${status})`);
	return { pds: pds.serviceEndpoint.replace(/\/$/, ''), handle: body.alsoKnownAs?.[0] };
}

/** Every DID the origin's index holds a declaration for, or null when the
 *  origin does not index declarations at all. */
async function indexedDids() {
	const dids = new Set();
	let cursor;
	do {
		const url = new URL('/xrpc/rsvp.atmo.declaration.listRecords', origin);
		url.searchParams.set('limit', '200');
		if (cursor) url.searchParams.set('cursor', cursor);
		const { status, body } = await json(url);
		if (status !== 200) return null;
		for (const r of body.records ?? []) dids.add(r.did);
		cursor = body.cursor;
	} while (cursor);
	return dids;
}

async function checkGroup(group, index) {
	let did, pds, handle;
	try {
		did = await resolveDid(group);
		({ pds, handle } = await pdsOf(did));
	} catch (e) {
		return fail(`${group}: resolve`, e.message);
	}
	const label = handle ? `${handle.replace('at://', '')} (${did})` : did;

	const page = await fetch(`${origin}/groups/${did}`, { redirect: 'manual' });
	if (page.status !== 200 && page.status !== 404) {
		return fail(`${label}: visibility`, `${origin}/groups/${did} answered ${page.status}`);
	}
	const isPublic = page.status === 200;

	const url = new URL('/xrpc/com.atproto.repo.getRecord', pds);
	url.searchParams.set('repo', did);
	url.searchParams.set('collection', COLLECTION);
	url.searchParams.set('rkey', 'self');
	const { status, body } = await json(url);

	if (!isPublic) {
		if (body.error === 'RecordNotFound') {
			if (index?.has(did)) {
				return fail(
					`${label}: withdrawn from its repo, but still in this origin's index`,
					'rsvp.atmo.declaration.listRecords lists it; the delete never reached the index'
				);
			}
			return pass(`${label}: not public on this origin, and not declared`);
		}
		return fail(
			`${label}: a group this origin hides is announced to the network`,
			`origin 404, but getRecord ${status} ${body.error ?? JSON.stringify(body.value)}`
		);
	}

	if (status !== 200) {
		return fail(
			`${label}: public on this origin, but NOT declared`,
			`getRecord ${status} ${body.error ?? ''} at ${pds} — no peer app can discover this group`
		);
	}
	const value = body.value ?? {};
	const want = `at://${did}/space/${ABOUT_SPACE_TYPE}/self`;
	const fields = Object.keys(value).sort().join(',');
	// Asserted on the raw JSON a stranger receives, not through our own shaping
	// code, which would only prove we agree with ourselves.
	if (value.$type !== COLLECTION || fields !== '$type,aboutSpace,createdAt') {
		return fail(`${label}: declaration shape`, `$type ${value.$type}; fields ${fields}`);
	}
	if (value.aboutSpace !== want) {
		return fail(
			`${label}: declaration points elsewhere`,
			`aboutSpace ${value.aboutSpace}, expected ${want}`
		);
	}
	if (Number.isNaN(Date.parse(value.createdAt))) {
		return fail(`${label}: declaration createdAt`, `not a date: ${value.createdAt}`);
	}
	const space = new URL('/xrpc/com.atproto.space.describeSpace', pds);
	space.searchParams.set('space', want);
	const described = await json(space);
	// 401 is the answer a spaces PDS gives a stranger; anything else means the
	// address the pointer names is not served there at all.
	if (described.status !== 401 && described.status !== 200) {
		return fail(
			`${label}: the pointer's PDS does not serve spaces`,
			`describeSpace ${described.status} ${described.body.error ?? ''}`
		);
	}
	if (index && !index.has(did)) {
		return fail(
			`${label}: declared, but not in this origin's index`,
			'rsvp.atmo.declaration.listRecords does not list it; Jetstream ingest never indexed it'
		);
	}
	const indexed = index ? ', indexed' : '';
	pass(`${label}: public, declared${indexed}, points at its own about space (${value.createdAt})`);
}

// ---------------------------------------------------------------------------

console.log(`GROUP DECLARATIONS on ${origin}\n`);

let groups = args;
if (groups.length === 0) {
	const res = await fetch(`${origin}/groups`);
	const html = res.status === 200 ? await res.text() : '';
	groups = [...new Set(html.match(/\/groups\/did:[a-z]+:[A-Za-z0-9._:%-]+/g) ?? [])].map((p) =>
		p.slice('/groups/'.length)
	);
	// A probe that checked nothing must not report success.
	if (groups.length === 0) {
		fail('enumerate', `${origin}/groups answered ${res.status} and links no group; name one`);
	} else {
		note(`${groups.length} group(s) discovered from ${origin}/groups`);
	}
}
const index = await indexedDids();
if (index === null) {
	fail('index', `${origin} does not serve rsvp.atmo.declaration.listRecords`);
} else {
	note(`${index.size} declaration(s) in ${origin}'s index`);
}
for (const group of groups) await checkGroup(group, index);

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

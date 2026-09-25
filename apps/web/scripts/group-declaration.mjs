#!/usr/bin/env node
/**
 * Checks that each group on a running deployment publishes its declaration
 * exactly when it should. Needs no credential.
 *
 *   node apps/web/scripts/group-declaration.mjs <origin> [group ...]
 *   node apps/web/scripts/group-declaration.mjs https://atmo.example.com
 *   node apps/web/scripts/group-declaration.mjs https://atmo.example.com kona.groups.example.com
 *
 * A group is a DID or a full handle. With none named, the script checks every
 * group the origin's /groups page links to.
 *
 * A public group announces itself with one record in its public repo, the
 * declaration, and a private group must not have one. Other apps discover
 * groups only through that record. groups-e2e.mjs tests the writer against a
 * fixture group; this script checks the groups a real origin serves, where a
 * missing declaration or a missed visibility change would show up.
 *
 * VISIBILITY comes from the origin, read the way a stranger reads it: an
 * anonymous GET of /groups/<did>. 200 is a public group, 404 is a private one
 * (or not a group here). The declaration is then fetched from the group's own
 * PDS, found through its DID document, and must agree:
 *
 *   public  -> the declaration exists, has exactly $type, aboutSpace and
 *              createdAt, and points at this DID's about space;
 *   private -> RecordNotFound. A declaration here announces a group whose
 *              owner chose not to be found, so it fails.
 *
 * Without a credential, the script can check that the pointer is the fixed
 * address of this group's about space and that the PDS serves spaces. It cannot
 * check that the space exists: the PDS answers an anonymous describeSpace with
 * 401 AuthMissing for a real space and a made-up one alike.
 *
 * The origin's own index must also agree. It indexes declarations from
 * Jetstream (rsvp.atmo.declaration.listRecords): a public group must be listed
 * and a private one must not. The list is read without an `actor` parameter on
 * purpose, because `actor` makes Contrail backfill that repo on demand, which
 * would pass even if Jetstream never carried the record. The index trails the
 * repo by up to one cron tick, so re-run a failure seen within a minute of a
 * visibility change before treating it as real.
 *
 * Anonymous and read-only: no login, no PDS write. Safe against any deployment.
 */
const args = process.argv.slice(2);
if (!args[0]?.startsWith('http')) {
	console.error('usage: node apps/web/scripts/group-declaration.mjs <origin> [group ...]');
	process.exit(2);
}
const origin = args.shift().replace(/\/$/, '');

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

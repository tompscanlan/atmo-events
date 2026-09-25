#!/usr/bin/env node
/**
 * Smoke check of the app's existing public pages against a running deployment.
 *
 *   node apps/web/scripts/inherited-surface.mjs <origin>
 *   node apps/web/scripts/inherited-surface.mjs https://atmo.example.com
 *
 * The groups work edits files that every page shares: the app shell, and the
 * Contrail config and init that the cron, the xrpc handler and every SSR read go
 * through. The unit tests do not render pages, so they can all pass while the
 * home feed returns a 500.
 *
 * This is not a feature test and does not check what a page shows. It asks one
 * question per page: does it still answer, with its own content rather than an
 * error page?
 *
 * Pages removed on purpose are listed at the end and asserted to be gone, so
 * bringing one back fails this script until the list is updated.
 *
 * Anonymous and read-only: no login, no invite code, no PDS write. Safe to run
 * against any deployment, including production.
 */
if (!process.argv[2]) {
	console.error('usage: node apps/web/scripts/inherited-surface.mjs <origin>');
	process.exit(2);
}
const origin = process.argv[2].replace(/\/$/, '');

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

async function get(path) {
	const res = await fetch(origin + path, { redirect: 'manual' });
	const body = res.status === 200 ? await res.text() : '';
	return { status: res.status, body, location: res.headers.get('location') };
}

/** An error shell is still HTTP 200 in SvelteKit, so a status check alone
 *  cannot tell a rendered page from a crash: SSR failure renders the error
 *  boundary with the message inside a 200. `marker` is therefore a string the
 *  page's own content must contain. */
async function expectPage(label, path, marker) {
	try {
		const { status, body } = await get(path);
		if (status !== 200) return fail(label, `${path} answered ${status}, expected 200`);
		if (/Internal Error|error id:/i.test(body.slice(0, 4000))) {
			return fail(label, `${path} rendered SvelteKit's error page`);
		}
		if (marker && !body.includes(marker)) {
			return fail(label, `${path} is 200 but does not contain ${JSON.stringify(marker)}`);
		}
		pass(`${label} (${path}, ${body.length} bytes)`);
	} catch (e) {
		fail(label, `${path} did not answer: ${e}`);
	}
}

async function expectStatus(label, path, want) {
	try {
		const { status, location } = await get(path);
		if (status !== want) return fail(label, `${path} answered ${status}, expected ${want}`);
		pass(`${label} (${path} -> ${status}${location ? ' ' + location : ''})`);
	} catch (e) {
		fail(label, `${path} did not answer: ${e}`);
	}
}

// ---------------------------------------------------------------------------

console.log(`INHERITED SURFACE of ${origin}\n`);

// The public read pages. Markers are the app's own nav labels and page
// headings, so a marker that stops matching means the shell changed, which is
// itself worth a look.
await expectPage('home feed renders', '/', 'calendar');
await expectPage('event list renders', '/events', 'events');
await expectPage('calendar renders', '/calendar', 'calendar');
await expectPage('topics render', '/topics', 'topics');
await expectPage('near-me renders', '/near-me', 'Events Near Me');
// /login has no server-rendered heading of its own (the modal mounts on the
// client), so the marker comes from the app shell it renders inside.
await expectPage('login renders', '/login', 'Create Event');

// An event, discovered rather than hardcoded: a pinned rkey rots the moment the
// deployment's data changes, and this has to stay runnable against any origin.
const events = await get('/events');
const actorEvent = events.body.match(/\/p\/(did:plc:[a-z0-9]+)\/e\/([a-z0-9]+)/);
if (!actorEvent) {
	note('no /p/<actor>/e/<rkey> link on /events — skipping the event, profile and embed checks');
} else {
	const [, actor, rkey] = actorEvent;
	note(`event under test, discovered from /events: ${actor} / ${rkey}`);
	await expectPage('profile renders', `/p/${actor}`, 'did:plc:');
	await expectPage('event view renders', `/p/${actor}/e/${rkey}`, rkey);
	// The embed routes let a third party show events on their own site. They
	// render outside the app shell, so nothing else here would notice them
	// breaking.
	await expectPage('embed renders', `/embed/p/${actor}/e/${rkey}`, rkey);
	await expectPage('og image route answers', `/p/${actor}/e/${rkey}/og.png`, '');
}

// Auth plumbing. The client metadata is what a PDS fetches to trust us at all:
// a wrong client_id breaks every login while every page still renders.
await expectStatus('create is gated on sign-in, not broken', '/create', 303);
const meta = await get('/oauth-client-metadata.json');
if (meta.status !== 200) {
	fail('oauth client metadata', `answered ${meta.status}`);
} else {
	const id = JSON.parse(meta.body).client_id;
	if (id === `${origin}/oauth-client-metadata.json`) pass(`oauth client metadata names ${id}`);
	else fail('oauth client metadata', `client_id is ${id}, which is not this origin`);
}
const jwks = await get('/oauth/jwks.json');
if (jwks.status === 200 && (JSON.parse(jwks.body).keys ?? []).length > 0)
	pass('oauth jwks serves a key');
else fail('oauth jwks', `status ${jwks.status}, body ${jwks.body.slice(0, 120)}`);

// Pages removed on purpose. Asserted gone, so restoring one fails here until it
// is taken off this list.
const removed = [
	['/settings', "upstream's notification settings, dropped with the notify service we do not run"]
];
for (const [path, why] of removed) {
	const { status } = await get(path);
	if (status === 404) pass(`removed on purpose, still absent: ${path} — ${why}`);
	else
		fail(
			`removed surface is back: ${path}`,
			`answered ${status}; update the inherited-surface ledger`
		);
}

console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

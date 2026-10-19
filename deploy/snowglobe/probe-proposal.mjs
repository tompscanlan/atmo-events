// Probes of the opensocial.group proposal on a seeded globe: what its group host does with a
// case the proposal leaves open, tried on the seeded groups. Run through seed.sh, which
// supplies the logins:
//
//   deploy/snowglobe/seed.sh <globe> probe-proposal.mjs
//
// Each probe prints what it saw and a FOUND or NOT FOUND line for the problem it looks for.
// It puts back what it changes, failed run or not. Exit 0 when every probe ran to the end,
// whatever it found.
//
// A small app signs people in as the group the way atmo does: the group host's OAuth flow,
// with the browser driven through their own account server's pages. Its callback is a
// loopback listener on this machine.
//
//   q1  two admins edit `permissions` at once. Both read it, the first writes a revocation,
//       the second writes its own change from its older copy. Found when the revoked grant is
//       back and neither write was refused. Then the second admin tries again passing
//       `swapRecord` with its stale CID, to see whether the host honors it, ignores it or
//       refuses the field.
//   q2  a member writes a fake `membership` naming themselves admin, in the group's members
//       space but in their own repo, which the space admits since members write their
//       acceptance there. Found when the group host offers them admin's grants at sign-in, or
//       atmo's members page shows them as admin.

import http from 'node:http';
import {
	ATMO,
	DOMAIN,
	GROUPS,
	PDS,
	closeBrowser,
	didOf,
	groupDid,
	handleOf,
	log,
	memberRole,
	newContext,
	ownPdsPages,
	session,
	shot,
	where,
	withAccess
} from './seed.mjs';
// atmo's own copies: deploy/ has no node_modules of its own.
import {
	OAuthClient,
	MemoryStore
} from '../../apps/web/node_modules/@atcute/oauth-node-client/dist/index.js';
import {
	CompositeDidDocumentResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver
} from '../../apps/web/node_modules/@atcute/identity-resolver/dist/index.js';

const NS = 'group.opensocial';
const META = `${NS}.meta`;
const MEMBERS = `${NS}.members`;
const HOST = `https://grouphost.${DOMAIN}`;
const spaceUri = (did, type) => `at://${did}/space/${type}/self`;
// What an admin's app asks for: read and write in the group's two standard spaces.
const SCOPES = [
	'atproto',
	`space:${META}?authority=self&skey=self&collection=*`,
	`space:${MEMBERS}?authority=self&skey=self&collection=*`
];

const results = [];
function finding(id, found, detail) {
	results.push({ id, found });
	log(`${found ? 'FOUND' : 'NOT FOUND'}  ${id}: ${detail}`);
}

// --- the app ------------------------------------------------------------------------

const actorResolver = new LocalActorResolver({
	handleResolver: new WellKnownHandleResolver(),
	didDocumentResolver: new CompositeDidDocumentResolver({
		methods: {
			plc: new PlcDidDocumentResolver({ apiUrl: `https://plc.${DOMAIN}` }),
			web: new WebDidDocumentResolver()
		}
	})
});
const CB_PORT = 39428;
const REDIRECT = `http://127.0.0.1:${CB_PORT}/cb`;

/** `name` signs in as the group through the group host. Returns the session and the scopes
 *  the host granted it, which are what the person's roles allow of what was asked. */
async function groupSignIn(name, group, scopes = SCOPES) {
	// One client per person: a client's sessions are keyed by account, and every session
	// here is for the same group DID.
	const app = new OAuthClient({
		metadata: { redirect_uris: [REDIRECT], scope: scopes.join(' ') },
		actorResolver,
		stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) }
	});
	const { url } = await app.authorize({
		target: { type: 'account', identifier: group },
		scope: scopes.join(' ')
	});
	let cbUrl = null;
	const server = http.createServer((rq, rs) => {
		cbUrl = `http://127.0.0.1:${CB_PORT}${rq.url}`;
		rs.end('ok');
	});
	await new Promise((r) => server.listen(CB_PORT, '127.0.0.1', r));
	const context = await newContext();
	const page = await context.newPage();
	try {
		await page.goto(url.toString(), { waitUntil: 'load', timeout: 60_000 });
		await ownPdsPages(page, name, async () => cbUrl !== null);
		const { session } = await app.callback(new URL(cbUrl).searchParams);
		const granted = (await session.getTokenInfo(false)).scope.split(' ').sort();
		log(`  ${name} signed in as ${group}: granted ${JSON.stringify(granted)}`);
		return { session, granted };
	} catch (e) {
		await shot(page, `signin-${name}`);
		throw new Error(`${name}'s sign-in as ${group}: ${e.message} (at ${where(page)})`);
	} finally {
		await context.close();
		await new Promise((r) => server.close(r));
	}
}

/** A call through an app's session for the group. */
async function as(s, method, nsid, { params, body } = {}) {
	const qs = params ? `?${new URLSearchParams(params)}` : '';
	const res = await s.handle(`/xrpc/${nsid}${qs}`, {
		method,
		...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {})
	});
	const text = await res.text();
	let json;
	try {
		json = text ? JSON.parse(text) : {};
	} catch {
		json = { raw: text.slice(0, 200) };
	}
	return { status: res.status, body: json };
}
const said = (r) =>
	`${r.status}${r.body?.error ? ` ${r.body.error}` : ''}${r.body?.message ? ` (${r.body.message})` : ''}`;

const getSelf = (s, group, collection) =>
	as(s, 'GET', 'com.atproto.space.getRecord', {
		params: { space: spaceUri(group, MEMBERS), repo: group, collection, rkey: 'self' }
	});
const putSelf = (s, group, collection, record, extra = {}) =>
	as(s, 'POST', 'com.atproto.space.putRecord', {
		body: {
			space: spaceUri(group, MEMBERS),
			repo: group,
			collection,
			rkey: 'self',
			record: { $type: collection, ...record },
			...extra
		}
	});

/** `permissions` with the member role's grant set to `scopes`. */
function withMemberScopes(value, scopes) {
	const grants = value.grants.map((g) => (g.role === 'member' ? { ...g, scopes } : g));
	if (!grants.some((g) => g.role === 'member'))
		grants.push({ role: 'member', scopes, assignable: [] });
	const { $type, ...rest } = value;
	return { ...rest, grants };
}
const memberScopes = (value) => value.grants.find((g) => g.role === 'member')?.scopes ?? [];

// --- q1: two admins, one record -----------------------------------------------------

async function q1(group) {
	log('\n## q1 two admins edit permissions at once\n');
	const PERM = `${NS}.permissions`;
	// A grant members can lose without harm: reading meta, which the meta space's access
	// already gives them.
	const REVOKED = `space:${META}?action=read`;
	const ADDED = `space:${MEMBERS}?action=read`;
	const A = await groupSignIn('ada', group);
	const D = await groupSignIn('dara', group);
	const start = await getSelf(A.session, group, PERM);
	if (start.status !== 200) throw new Error(`reading permissions: ${said(start)}`);
	const original = start.body.value;
	log(`  member's grant at the start: ${JSON.stringify(memberScopes(original))}`);
	try {
		const set = await putSelf(A.session, group, PERM, withMemberScopes(original, [REVOKED]));
		if (set.status !== 200) throw new Error(`setting up the grant: ${said(set)}`);
		const a = await getSelf(A.session, group, PERM);
		const d = await getSelf(D.session, group, PERM);
		log(`  both read it: ada cid ${a.body.cid}, dara cid ${d.body.cid}`);
		const revoke = await putSelf(A.session, group, PERM, withMemberScopes(a.body.value, []));
		log(`  ada revokes ${REVOKED}: ${said(revoke)}`);
		const stale = withMemberScopes(d.body.value, [...memberScopes(d.body.value), ADDED]);
		const add = await putSelf(D.session, group, PERM, stale);
		log(`  dara adds ${ADDED} from her older copy: ${said(add)}`);
		const after = await getSelf(A.session, group, PERM);
		const scopes = memberScopes(after.body.value);
		finding(
			'q1 a revocation comes back',
			revoke.status === 200 && add.status === 200 && scopes.includes(REVOKED),
			`member's grant after both writes: ${JSON.stringify(scopes)}; both writes ${revoke.status}/${add.status}`
		);

		// The same lost write, passing the stale CID as swapRecord.
		const now = await getSelf(D.session, group, PERM);
		const revoke2 = await putSelf(A.session, group, PERM, withMemberScopes(now.body.value, []));
		const swapped = await putSelf(
			D.session,
			group,
			PERM,
			withMemberScopes(now.body.value, [REVOKED, ADDED]),
			{
				swapRecord: now.body.cid
			}
		);
		const after2 = await getSelf(A.session, group, PERM);
		const honored =
			swapped.status !== 200 && /swap/i.test(`${swapped.body?.error} ${swapped.body?.message}`);
		log(
			`  with swapRecord ${now.body.cid} after ada's second revoke (${said(revoke2)}): dara's write ${said(swapped)}; member's grant now ${JSON.stringify(memberScopes(after2.body.value))}`
		);
		finding(
			'q1 swapRecord does not stop it',
			!honored,
			honored
				? 'the host refused the stale write as a failed swap'
				: `the stale write got ${said(swapped)}`
		);
	} finally {
		const back = await putSelf(A.session, group, PERM, original);
		log(`  put back the original permissions: ${said(back)}`);
	}
}

// --- q2: a fake membership in a member's own repo ------------------------------------

async function q2(groupKey, group, who) {
	log(`\n## q2 ${who} writes a membership naming themselves admin, in their own repo\n`);
	const MEM = `${NS}.membership`;
	const member = didOf(who);
	const token = await session(who);
	const call = async (nsid, body) => {
		const res = await fetch(`${PDS}/xrpc/${nsid}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : {} };
	};
	const where_ = { space: spaceUri(group, MEMBERS), repo: member, collection: MEM, rkey: member };
	const before = await groupSignIn(who, group);
	const fake = await call('com.atproto.space.putRecord', {
		...where_,
		record: { $type: MEM, member, roles: ['admin'], createdAt: new Date().toISOString() }
	});
	log(`  ${who} writes it at their own account server: ${said(fake)}`);
	try {
		if (fake.status !== 200) {
			finding(
				'q2 a fake membership is believed',
				false,
				`the write itself was refused: ${said(fake)}`
			);
			return;
		}
		const after = await groupSignIn(who, group);
		const gained = after.granted.filter((s) => !before.granted.includes(s));
		// An admin-only write, harmless if it lands: a role nobody holds, deleted at once.
		const roleAt = {
			space: spaceUri(group, MEMBERS),
			repo: group,
			collection: `${NS}.role`,
			rkey: 'probe'
		};
		const tried = await as(after.session, 'POST', 'com.atproto.space.putRecord', {
			body: { ...roleAt, record: { $type: `${NS}.role`, displayName: 'Probe' } }
		});
		if (tried.status === 200)
			await as(after.session, 'POST', 'com.atproto.space.deleteRecord', { body: roleAt });
		log(`  as the group, ${who} tries to add a role (admin only): ${said(tried)}`);
		const page = await withAccess('ada', groupKey, '/members');
		const role = await memberRole(page, who);
		await page.close();
		log(`  atmo's members page, as ada: ${who}'s role ${role}`);
		finding(
			'q2 a fake membership is believed',
			gained.length > 0 || tried.status === 200 || role === 'admin',
			`host granted ${gained.length ? `more: ${JSON.stringify(gained)}` : 'nothing more'} and answered the admin-only write ${tried.status}; atmo shows ${who} as ${role}`
		);
	} finally {
		const gone = await call('com.atproto.space.deleteRecord', where_);
		log(`  deleted the fake membership: ${said(gone)}`);
	}
}

// --- run ----------------------------------------------------------------------------

let failed = false;
try {
	const runners = await groupDid(GROUPS.find((g) => g.key === 'runners'));
	if (!runners) throw new Error('the runners group does not resolve; seed the globe first');
	log(
		`group runners ${runners}, atmo ${ATMO}, host ${HOST}, members ${handleOf('ada')} and others`
	);
	for (const [name, probe] of [
		['q1', () => q1(runners)],
		['q2', () => q2('runners', runners, 'eli')]
	]) {
		try {
			await probe();
		} catch (e) {
			failed = true;
			log(`ERROR  ${name}: ${e.message}`);
		}
	}
} finally {
	await closeBrowser();
}
log(
	`\n${results.filter((r) => r.found).length} of ${results.length} problems found${failed ? '; a probe did not finish' : ''}`
);
process.exit(failed ? 1 : 0);

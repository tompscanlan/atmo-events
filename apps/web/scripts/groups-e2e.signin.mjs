// The groups e2e's real sign-ins, for a run against a group host (E2E_GROUP_HOST).
// A stand-in run logs in with passwords. A host holds no password for a group and
// cuts each person's group session to their roles, so this run signs each person
// in as a person does: an OAuth client on this machine (a loopback client, whose
// metadata is its client id, so no PDS keeps a copy that could go stale), a
// Chromium on the devnet for the pages, and the person's own password typed into
// their own PDS's sign-in page, never sent anywhere else.
//
// The sessions stay in this driver. The worker reaches them through a bridge on
// 127.0.0.1 (`startBridge`): it hands over each request it would have sent, and
// the driver sends it on that person's session, through the ledger's guarded
// fetch, so check 24 still counts every request. Imported only by a host run,
// after the fetch guard is in place.
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { MemoryStore, OAuthClient } from '@atcute/oauth-node-client';

/** The devnet's names, which Chromium resolves to 127.0.0.1, where its nginx answers. */
const DEVNET_NAMES = [
	'alpha.devnet.test',
	'regular.devnet.test',
	'prod.devnet.test',
	'*.devnet.test',
	'*.regular.devnet.test',
	'*.prod.devnet.test',
	'plc.directory',
	'*.devnet.internal'
];

/** The devnet's leaf certificate, the one key Chromium is told to trust past its roots. */
function leafFile() {
	if (process.env.DEVNET_LEAF_FILE) return process.env.DEVNET_LEAF_FILE;
	const ca = process.env.DEVNET_CA_FILE || process.env.NODE_EXTRA_CA_CERTS;
	if (!ca) throw new Error("set DEVNET_LEAF_FILE, or run under the devnet's scripts/https-run");
	return join(dirname(ca), 'leaf.crt');
}

function leafSpki(path) {
	const cert = new X509Certificate(readFileSync(path));
	return createHash('sha256')
		.update(cert.publicKey.export({ type: 'spki', format: 'der' }))
		.digest('base64');
}

/**
 * Resolves a DID at the devnet's PLC and nothing else, the PDS from its document
 * and the handle as it claims, unverified: the sign-ins name people by DID, so no
 * handle is looked up and no lookup leaves this machine.
 * @param {string} plcUrl
 * @param {typeof fetch} fetch
 */
function plcActorResolver(plcUrl, fetch) {
	return {
		async resolve(actor) {
			if (!String(actor).startsWith('did:')) throw new Error(`sign in by DID, not ${actor}`);
			const res = await fetch(new URL(`/${encodeURIComponent(actor)}`, plcUrl));
			if (!res.ok) throw new Error(`${actor} is not on the devnet PLC (${res.status})`);
			const doc = await res.json();
			const pds = (doc.service ?? []).find((s) => String(s.id).endsWith('#atproto_pds'));
			if (!pds) throw new Error(`${actor} names no PDS`);
			const aka = (doc.alsoKnownAs ?? []).find((a) => String(a).startsWith('at://'));
			return {
				did: actor,
				handle: aka ? aka.slice('at://'.length) : 'handle.invalid',
				pds: pds.serviceEndpoint
			};
		}
	};
}

/** A one-shot server for the redirect back, on a port of its own. */
async function callbackServer() {
	let resolve;
	const got = new Promise((r) => (resolve = r));
	const server = http.createServer((req, res) => {
		res.end('ok');
		resolve(new URL(req.url, 'http://127.0.0.1').searchParams);
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		redirectUri: `http://127.0.0.1:${port}/cb`,
		got,
		close: () => new Promise((r) => server.close(r))
	};
}

/**
 * The run's sign-ins. One Chromium for the run, a fresh context for each sign-in
 * so no PDS cookie carries one person into the next. Every request the browser
 * makes is put to the ledger first; one it refuses is aborted, never sent.
 * @param {{ plcUrl: string, fetch: typeof fetch, ledger: { admit: Function },
 *   playwright: string, log: (line: string) => void }} options
 */
export async function createSignIns({ plcUrl, fetch, ledger, playwright, log }) {
	const { chromium } = createRequire(import.meta.url)(playwright);
	const browser = await chromium.launch({
		args: [
			`--host-resolver-rules=${DEVNET_NAMES.map((n) => `MAP ${n} 127.0.0.1`).join(', ')}`,
			`--ignore-certificate-errors-spki-list=${leafSpki(leafFile())}`
		]
	});
	const actorResolver = plcActorResolver(plcUrl, fetch);

	/** One trip: the client's authorization URL, the pages, the code exchange. */
	async function signIn(person, { target, scope, prompt, pages }) {
		const cb = await callbackServer();
		const client = new OAuthClient({
			metadata: { redirect_uris: [cb.redirectUri], scope },
			actorResolver,
			stores: { sessions: new MemoryStore(), states: new MemoryStore({ ttl: 600_000 }) },
			fetch
		});
		const context = await browser.newContext();
		await context.route('**/*', (route) => {
			const request = route.request();
			return ledger.admit('driver', request.method(), request.url())
				? route.continue()
				: route.abort();
		});
		try {
			const { url } = await client.authorize({ target, scope, ...(prompt ? { prompt } : {}) });
			const page = await context.newPage();
			await page.goto(url.toString(), { waitUntil: 'load', timeout: 60_000 });
			const seen = await pages(page, cb.got);
			// The host turned them away: no redirect comes back, and none is waited for.
			if (seen?.refusal) return seen;
			const params = await Promise.race([
				cb.got,
				new Promise((_, reject) =>
					setTimeout(() => reject(new Error(`no redirect back for ${person.did}`)), 60_000)
				)
			]);
			const { session } = await client.callback(params);
			const { scope: granted } = await session.getTokenInfo(false);
			return { session, scope: granted, client, ...seen };
		} finally {
			await context.close();
			await cb.close();
		}
	}

	/** Their own PDS's sign-in page: the handle if it asks, the password, then
	 *  each consent button, until the redirect back arrives. */
	async function ownPdsPages(page, person, done, onPage = async () => false) {
		let finished = false;
		done.then(() => (finished = true));
		await page.waitForSelector('input[name=password]', { timeout: 30_000 });
		const user = page.locator('input[name=username]');
		if ((await user.count()) && (await user.isEditable()) && !(await user.inputValue())) {
			await user.fill(person.handle);
		}
		await page.fill('input[name=password]', person.password);
		await page.getByRole('button', { name: 'Sign in' }).click();
		for (let i = 0; i < 120 && !finished; i++) {
			if (await onPage(page)) continue;
			const button = page.getByRole('button', { name: /^(accept|authorize|allow)/i }).first();
			if (await button.isVisible().catch(() => false)) {
				await button.click();
				await page.waitForTimeout(1000);
				continue;
			}
			await page.waitForTimeout(500);
		}
	}

	return {
		/** `person`'s own sign-in at their own PDS, with no host in the path. */
		async own(person, scope) {
			const out = await signIn(person, {
				target: { type: 'account', identifier: person.did },
				scope,
				pages: (page, done) => ownPdsPages(page, person, done)
			});
			// A PDS may write a typed grant back with its collections filled in, so a
			// granted item is matched to an asked one by its resource and authority.
			const key = (item) => {
				const [resource, query = ''] = item.split('?');
				return `${resource}?${new URLSearchParams(query).get('authority') ?? ''}`;
			};
			const granted = new Set(out.scope.split(' ').map(key));
			// A permission set (`include:`) comes back as the items it bundles.
			const asked = scope.split(' ').filter((item) => !item.startsWith('include:'));
			const missing = asked.filter((item) => !granted.has(key(item)));
			log(
				`${person.did} signed in at their own PDS (a real OAuth session): granted ` +
					`${out.scope.split(' ').length} item(s); of the ${asked.length} asked outside permission ` +
					`sets, ${missing.length ? `not granted: ${missing.join(' ')}` : 'none missing'}`
			);
			return out;
		},

		/**
		 * `person`'s group session from the host: its sign-in page (with the new
		 * group's address for a create), their own PDS, and the host's consent,
		 * whose offered and dropped items are handed back.
		 * @param {{ create?: { label: string, displayName: string }, groupDid?: string, scope: string, host: string }} options
		 */
		async group(person, { create, groupDid, scope, host }) {
			const consent = { kept: [], dropped: [] };
			const out = await signIn(person, {
				target: create
					? { type: 'pds', serviceUrl: host }
					: { type: 'account', identifier: groupDid },
				scope,
				prompt: create ? 'create' : undefined,
				pages: async (page, done) => {
					await page.waitForSelector('input[name=handle]', { timeout: 30_000 });
					if (create) {
						await page.fill('input[name=label]', create.label);
						await page.fill('input[name=displayName]', create.displayName);
					}
					await page.fill('input[name=handle]', person.handle);
					await page.click('button');
					await ownPdsPages(page, person, done, async (p) => {
						if (new URL(p.url()).origin !== new URL(host).origin) return false;
						if (
							!(await p
								.locator('#consent')
								.isVisible()
								.catch(() => false))
						)
							return false;
						consent.kept = await p.locator('#kept li').allInnerTexts();
						consent.dropped = await p.locator('#dropped li').allInnerTexts();
						await p.click('#go');
						await p.waitForTimeout(1000);
						return true;
					});
					return { consent };
				}
			});
			log(
				`${person.did} holds a group session on ${out.session.did} from the host ` +
					`(${consent.kept.length} item(s) offered, ${consent.dropped.length} dropped)`
			);
			return out;
		},

		/**
		 * `person` asks for a group session they hold no role for: their own PDS
		 * signs them in, and the host answers its sign-in callback with a refusal
		 * where its consent would be. Hands back that answer's status and text; a
		 * redirect back, or no answer, fails the run.
		 * @param {{ groupDid: string, scope: string }} options
		 */
		async groupRefused(person, { groupDid, scope }) {
			const out = await signIn(person, {
				target: { type: 'account', identifier: groupDid },
				scope,
				pages: async (page, done) => {
					let answer = null;
					let stop;
					const stopped = new Promise((r) => (stop = r));
					// The host's own sign-in may answer on its loopback address, not the
					// public one, so its callback is known by path; no PDS serves it.
					page.on('response', (response) => {
						if (new URL(response.url()).pathname === '/signin/callback') answer = response;
					});
					await page.waitForSelector('input[name=handle]', { timeout: 30_000 });
					await page.fill('input[name=handle]', person.handle);
					await page.click('button');
					/** @type {{ status: number, text: string } | null} */
					let refusal = null;
					await ownPdsPages(page, person, Promise.race([done, stopped]), async () => {
						if (!answer) return false;
						refusal = { status: answer.status(), text: (await answer.text()).trim() };
						stop();
						return true;
					});
					if (!refusal) throw new Error(`the host did not refuse ${person.did} a group session`);
					return { refusal };
				}
			});
			log(
				`${person.did} asked for a group session on ${groupDid} and the host answered ` +
					`${out.refusal.status}: ${out.refusal.text}`
			);
			return out.refusal;
		},

		close: () => browser.close()
	};
}

/**
 * The worker's way to the driver's sessions. `/own/<did>/<path>` goes out on that
 * person's own session, `/group/<group>/<person>/<path>` on their group session,
 * and `/scope/<did>` answers the scope their own sign-in was granted. The method,
 * body and the headers a call carries come through; the answer goes back as sent.
 */
export async function startBridge() {
	/** @type {Map<string, { session: any, scope: string }>} */
	const own = new Map();
	/** @type {Map<string, any>} */
	const groups = new Map();
	const PASSED = ['content-type', 'accept', 'atproto-proxy', 'atproto-accept-labelers'];
	const server = http.createServer(async (req, res) => {
		try {
			const url = new URL(req.url, 'http://bridge');
			const [, kind, a, b] = url.pathname.split('/');
			if (kind === 'scope') {
				const entry = own.get(decodeURIComponent(a));
				res.writeHead(entry ? 200 : 404, { 'content-type': 'text/plain' });
				return res.end(entry?.scope ?? '');
			}
			const session =
				kind === 'own'
					? own.get(decodeURIComponent(a))?.session
					: kind === 'group'
						? groups.get(`${decodeURIComponent(a)} ${decodeURIComponent(b)}`)
						: undefined;
			if (!session) {
				res.writeHead(503, { 'content-type': 'application/json' });
				return res.end(JSON.stringify({ error: 'NoBridgedSession', message: url.pathname }));
			}
			const skip = kind === 'own' ? 3 : 4;
			const path = `/${url.pathname.split('/').slice(skip).join('/')}${url.search}`;
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			const headers = {};
			for (const name of PASSED) if (req.headers[name]) headers[name] = String(req.headers[name]);
			const answer = await session.handle(path, {
				method: req.method,
				headers,
				...(chunks.length ? { body: Buffer.concat(chunks) } : {})
			});
			const type = answer.headers.get('content-type');
			res.writeHead(answer.status, type ? { 'content-type': type } : {});
			res.end(Buffer.from(await answer.arrayBuffer()));
		} catch (error) {
			res.writeHead(502, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ error: 'BridgeFailed', message: String(error?.message ?? error) }));
		}
	});
	await new Promise((r) => server.listen(0, '127.0.0.1', r));
	const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
	return {
		url: `http://127.0.0.1:${port}`,
		setOwn: (did, session, scope) => own.set(did, { session, scope }),
		setGroup: (groupDid, personDid, session) => groups.set(`${groupDid} ${personDid}`, session),
		close: () => new Promise((r) => server.close(r))
	};
}

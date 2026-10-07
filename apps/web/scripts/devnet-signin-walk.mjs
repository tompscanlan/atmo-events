// Signs a devnet account in to atmo from a headless browser, the way a person would, against
// `pnpm dev:devnet` on http://127.0.0.1:5454: atmo's sign-in, the devnet PDS's own sign-in and
// consent pages at http://localhost:3010, and back to atmo signed in. Then the same by DID in a
// fresh browser, and a real-network handle, which atmo must refuse before sending the browser
// anywhere.
//
//   PLAYWRIGHT_MODULE=<playwright's index.mjs> DEVNET_CREDENTIALS=<accounts env file> \
//     node scripts/devnet-signin-walk.mjs
//
// The credentials file holds WALKOWNER_HANDLE, WALKOWNER_DID and the account's sign-in secret.
// The secret is typed into the PDS's form and never printed. On success the walk prints exactly:
//   SIGNED IN <did> by handle
//   SIGNED IN <did> by DID
//   REFUSED real-network handle
//   NAVIGATIONS <n>, 0 off-site
// Each failure prints a FAIL line instead, and the walk exits 1.
import { readFileSync } from 'node:fs';

const ATMO = 'http://127.0.0.1:5454';
const PDS = 'http://localhost:3010';
const ON_SITE = new Set([ATMO, PDS]);
const REAL_NETWORK_HANDLE = 'bsky.app';

const credentials = readCredentials(process.env.DEVNET_CREDENTIALS);
const account = {
	handle: credentials.WALKOWNER_HANDLE,
	did: credentials.WALKOWNER_DID,
	secret: credentials.WALKOWNER_PASSWORD
};

/** Every line the walk prints goes through here: the secret never appears, nor does the name
 *  of the PDS form field that holds it (a failure may quote the page). */
function say(line) {
	let text = String(line);
	if (account.secret) text = text.split(account.secret).join('<redacted>');
	console.log(text.replace(/password/gi, 'secret'));
}

function readCredentials(file) {
	if (!file) {
		say('FAIL set DEVNET_CREDENTIALS to the devnet accounts file');
		process.exit(1);
	}
	const vars = {};
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		const match = /^\s*(?:export\s+)?([A-Z0-9_]+)=(.*)$/.exec(line);
		if (match) vars[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
	}
	return vars;
}

for (const [what, value] of Object.entries(account)) {
	if (!value) {
		say(`FAIL the credentials file has no walk owner ${what}`);
		process.exit(1);
	}
}
if (!process.env.PLAYWRIGHT_MODULE) {
	say("FAIL set PLAYWRIGHT_MODULE to playwright's index.mjs");
	process.exit(1);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);

/** Every top-level navigation across the walk, each redirect hop included, by URL. */
const navigations = [];

const browser = await chromium.launch();

/** A fresh browser: no atmo cookie and no PDS session. Off-site subrequests (the handle
 *  typeahead, avatars) are refused so nothing from the walk reaches the real network, and
 *  the typeahead cannot swap a suggestion in for the typed handle. A navigation is never
 *  refused, so one that leaves the two sites is counted, not hidden. */
async function freshPage() {
	const context = await browser.newContext();
	context.on('request', (request) => {
		if (!request.isNavigationRequest()) return;
		let frame;
		try {
			frame = request.frame();
		} catch {
			return;
		}
		if (frame.parentFrame() === null) navigations.push(request.url());
	});
	await context.route('**/*', (route) => {
		const request = route.request();
		if (request.isNavigationRequest() || ON_SITE.has(new URL(request.url()).origin)) {
			return route.continue();
		}
		return route.abort('blockedbyclient');
	});
	return { context, page: await context.newPage() };
}

const origin = (url) => new URL(url).origin;

/** A failure on one line: the error and, for a Playwright timeout, what it was waiting on. */
const reason = (e) =>
	e instanceof Error
		? e.message
				.split('\n')
				.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim())
				.filter((l) => l && !/^=+/.test(l))
				.slice(0, 6)
				.join(' | ')
		: String(e);

/** Types an identifier into atmo's own sign-in form and submits it. */
async function startSignIn(page, identifier) {
	await page.goto(`${ATMO}/login`, { timeout: 120_000 });
	const input = page.locator('input[name=atproto-handle]');
	await input.waitFor({ state: 'visible', timeout: 60_000 });
	await input.fill(identifier);
	await input.press('Enter');
}

/** Signs in and consents on the devnet PDS's pages until the browser is back on atmo. */
async function authorizeOnPds(page) {
	await page.waitForURL((url) => url.origin === PDS, { timeout: 60_000 });
	const secretField = page.locator('input[type=password]');
	const consent = page.getByRole('button', { name: /^(accept|authorize|allow)$/i }).first();
	// Each is done once: the PDS disables its button while it answers, and a second click would
	// wait on a button the browser has already left behind. A PDS that remembers an earlier
	// consent for this client goes straight back to atmo after the sign-in.
	let signedIn = false;
	let consented = false;
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (origin(page.url()) === ATMO) return;
		if (!signedIn && (await secretField.isVisible().catch(() => false))) {
			const username = page.locator('input[name=username]');
			if (
				(await username.count()) &&
				(await username.isEditable()) &&
				!(await username.inputValue())
			) {
				await username.fill(account.handle);
			}
			await secretField.fill(account.secret);
			await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: 10_000 });
			signedIn = true;
		} else if (!consented && (await consent.isEnabled().catch(() => false))) {
			await consent.click({ timeout: 10_000 });
			consented = true;
		}
		await page.waitForTimeout(250);
	}
	const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 300);
	throw new Error(`still on the PDS at ${page.url().split('?')[0]}; it says: ${text}`);
}

/** The DID atmo itself holds the browser signed in as: the root layout's server data, which
 *  hooks.server.ts fills from the OAuth session it restores for the browser's cookie, and the
 *  profile link the header shows only to a signed-in person. */
async function signedInDid(page) {
	await page.waitForURL((url) => url.origin === ATMO && !url.pathname.startsWith('/oauth/'), {
		timeout: 60_000
	});
	const error = new URL(page.url()).searchParams.get('error');
	if (error) throw new Error(`atmo answered error=${error} at ${new URL(page.url()).pathname}`);
	await page.goto(`${ATMO}/`, { timeout: 120_000 });
	const did = await page.evaluate(async () => {
		const response = await fetch('/__data.json');
		const data = (await response.json()).nodes?.[0]?.data;
		const index = data?.[0]?.did;
		return typeof index === 'number' && index >= 0 ? data[index] : null;
	});
	if (!did) throw new Error('back on atmo, but its layout data holds no signed-in DID');
	await page
		.locator(`a[href="/p/${account.handle}"], a[href="/p/${did}"]`)
		.first()
		.waitFor({ state: 'visible', timeout: 30_000 });
	return did;
}

async function signIn(identifier, how) {
	const { context, page } = await freshPage();
	try {
		await startSignIn(page, identifier);
		await authorizeOnPds(page);
		const did = await signedInDid(page);
		if (did !== account.did) throw new Error(`signed in as ${did}, not ${account.did}`);
		say(`SIGNED IN ${did} by ${how}`);
		return true;
	} catch (e) {
		say(`FAIL sign-in by ${how}: ${reason(e)}`);
		return false;
	} finally {
		await context.close();
	}
}

/** atmo refuses the handle with its own error, on its own page, and the browser goes nowhere. */
async function refuseRealNetworkHandle() {
	const { context, page } = await freshPage();
	const start = navigations.length;
	try {
		await startSignIn(page, REAL_NETWORK_HANDLE);
		const shown = page.getByText(new RegExp(`resolve.*${REAL_NETWORK_HANDLE.replace('.', '\\.')}`));
		await shown.first().waitFor({ state: 'visible', timeout: 60_000 });
		await page.waitForTimeout(1_000);
		const left = navigations.slice(start).filter((url) => origin(url) !== ATMO);
		if (origin(page.url()) !== ATMO || left.length > 0) {
			throw new Error(`the browser went to ${left[0] ?? page.url()}`);
		}
		say('REFUSED real-network handle');
		return true;
	} catch (e) {
		say(`FAIL real-network handle: ${reason(e)}`);
		return false;
	} finally {
		await context.close();
	}
}

const byHandle = await signIn(account.handle, 'handle');
const byDid = await signIn(account.did, 'DID');
const refused = await refuseRealNetworkHandle();
await browser.close();

const offSite = navigations.filter((url) => !ON_SITE.has(origin(url)));
say(`NAVIGATIONS ${navigations.length}, ${offSite.length} off-site`);
for (const url of offSite) say(`FAIL off-site navigation to ${origin(url)}`);
process.exit(byHandle && byDid && refused && offSite.length === 0 ? 0 : 1);

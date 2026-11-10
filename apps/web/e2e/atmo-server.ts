// What the e2e tests share on every network: atmo's server, which e2e/setup.ts starts, the settings a
// network's e2e app gives the tests, and atmo's cron.

/** atmo's dev server. Its loopback OAuth client returns here (DEV_PORT in src/lib/atproto/settings.ts). */
export const ATMO = 'http://127.0.0.1:5454';

/** A setting from the network's e2e app (apps[].env in its snowglobe file). */
export function required(name: string) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`${name} is not set. Run the e2e tests with pnpm test:e2e.`);
	return value;
}

/** One run of atmo's cron, which takes new records from the network's Jetstream. */
export async function runCron(secret: string) {
	const response = await fetch(`${ATMO}/api/cron`, {
		method: 'POST',
		// As a built Worker's own scheduled() sends it (scripts/build-worker.mjs): SvelteKit 3
		// CSRF-checks a POST with no content type.
		headers: { 'X-Cron-Secret': secret, 'content-type': 'application/json' }
	});
	if (!response.ok) throw new Error(`atmo's cron: ${response.status}`);
}

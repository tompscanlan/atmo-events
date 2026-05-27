import { Contrail } from '@atmo-dev/contrail';
import { createHandler } from '@atmo-dev/contrail/server';
import { Client } from '@atcute/client';
import { config } from '../contrail.config';
import { getSpacesConfig, spacesAvailable } from '../spaces/config';

const spaces = getSpacesConfig();
if (!spacesAvailable()) {
	console.warn(
		'[contrail/spaces] No service DID configured — spaces features will be inactive. Run `pnpm tunnel` in dev to enable.'
	);
}

export const contrail = new Contrail({ ...config, ...(spaces ? { spaces } : {}) });

let initialized = false;
let networkOverridesApplied = false;

function applyNetworkOverrides(env: App.Platform['env']) {
	if (networkOverridesApplied) return;
	networkOverridesApplied = true;

	if (env.PDS_URL) {
		const pdsOrigin = env.PDS_URL.replace(/\/$/, '');
		const savedFetch = globalThis.fetch;
		globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			if (typeof input === 'string' && input.includes('devnet.test')) {
				input = input.replace(/https?:\/\/devnet\.test(:\d+)?/, pdsOrigin);
			}
			return savedFetch(input, init);
		}) as typeof fetch;
	}
}

export async function ensureInit(db: D1Database, env?: App.Platform['env']) {
	if (env) applyNetworkOverrides(env);
	if (!initialized) {
		await contrail.init(db);
		initialized = true;
	}
}

const handle = createHandler(contrail);

/**
 * Server-side: fully typed @atcute/client that routes through contrail in-process.
 * No HTTP roundtrip — calls createHandler directly.
 */
export function getServerClient(db: D1Database) {
	return new Client({
		handler: async (pathname, init) => {
			await ensureInit(db);
			const url = new URL(pathname, 'http://localhost');
			return handle(new Request(url, init), db) as Promise<Response>;
		}
	});
}

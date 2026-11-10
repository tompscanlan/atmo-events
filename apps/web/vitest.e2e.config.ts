// atmo end to end, on a local atproto network: `pnpm test:e2e` from the repo root for the network in
// snowglobe.yml, `pnpm test:e2e:private` for snowglobe.private-events.yml. e2e/setup.ts starts
// atmo's dev server with that network's settings; the tests drive a Chromium through real sign-ins
// at each person's own PDS.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Each network has its own accounts and settings, so each runs its own suite: e2e/atmo.e2e.ts on
// snowglobe.yml's, or the one another network's e2e app names in E2E_SUITE.
const suite = process.env.E2E_SUITE?.trim() || 'atmo';
const file = `e2e/${suite}.e2e.ts`;
if (!/^[a-z][a-z-]*$/.test(suite) || !existsSync(fileURLToPath(new URL(file, import.meta.url)))) {
	throw new Error(`E2E_SUITE is ${suite}, and there is no ${file}.`);
}

export default defineConfig({
	test: {
		include: [file],
		globalSetup: ['e2e/setup.ts'],
		// One file at a time: the tests share the network and one dev server.
		fileParallelism: false,
		testTimeout: 180_000,
		hookTimeout: 180_000
	}
});

// Bundles the groups e2e Worker with Vite, like the app's server build, so the
// modules compile the way they ship and the `?raw` migration import in schema.ts
// works. Shared by the e2e driver and by the build check, which needs no devnet.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER_ENTRY = join(WEB_DIR, 'scripts/groups-e2e.worker.ts');

/** Writes `worker.js` into `outDir`. `plcUrl` is the only PLC the bundled
 *  identity resolver will ask. */
export async function bundleWorker(outDir, plcUrl) {
	await build({
		configFile: false,
		root: WEB_DIR,
		logLevel: 'error',
		ssr: { target: 'webworker', noExternal: true },
		resolve: {
			alias: [
				{
					find: '$app/environment',
					replacement: join(WEB_DIR, 'scripts/groups-e2e.app-environment.js')
				},
				// Exactly this module: the stand-in for the group's linked session.
				{
					find: /^\$lib\/atproto\/server\/oauth$/,
					replacement: join(WEB_DIR, 'scripts/groups-e2e.oauth.ts')
				},
				// Devnet's PLC directory, the only one asked.
				{
					find: /^@atcute\/identity-resolver$/,
					replacement: join(WEB_DIR, 'scripts/groups-e2e.identity-resolver.ts')
				}
			]
		},
		define: { __E2E_PLC_URL__: JSON.stringify(plcUrl) },
		build: {
			ssr: WORKER_ENTRY,
			outDir,
			emptyOutDir: true,
			minify: false,
			target: 'esnext',
			rollupOptions: { output: { entryFileNames: 'worker.js', format: 'es' } }
		}
	});
}

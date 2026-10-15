// Bundles ./group-host-adapter.entry.ts for Node with Vite, the way
// ./groups-e2e.build.mjs bundles the e2e Worker, so a devnet probe outside this
// repo runs the app's own modules. Writes `adapter.js` into `outDir`.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function bundleAdapter(outDir) {
	await build({
		configFile: false,
		root: WEB_DIR,
		logLevel: 'error',
		ssr: { target: 'node', noExternal: true, external: ['node:sqlite'] },
		resolve: {
			alias: [
				{
					find: '$app/environment',
					replacement: join(WEB_DIR, 'scripts/groups-e2e.app-environment.js')
				},
				{ find: /^\$lib\//, replacement: join(WEB_DIR, 'src/lib/') }
			]
		},
		build: {
			ssr: join(WEB_DIR, 'scripts/group-host-adapter.entry.ts'),
			outDir,
			emptyOutDir: true,
			minify: false,
			target: 'node22',
			rollupOptions: { output: { entryFileNames: 'adapter.js', format: 'es' } }
		}
	});
	return join(outDir, 'adapter.js');
}

import adapter from '@sveltejs/adapter-cloudflare';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// `pnpm dev:devnet` sets DEVNET_BINDINGS, and vite dev then emulates the bindings and vars of
// devnet/wrangler.jsonc, stored under .wrangler/devnet, instead of ./wrangler.jsonc's.
const platformProxy = process.env.DEVNET_BINDINGS
	? { configPath: 'devnet/wrangler.jsonc', persist: { path: '.wrangler/devnet' } }
	: undefined;

/** @type {import('@sveltejs/kit').Config} */
const config = {
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter({ platformProxy }),
		alias: {
			'@atmo-dev/events-ui': '../../packages/ui/src'
		},
		experimental: {
			remoteFunctions: true
		}
	}
};

export default config;

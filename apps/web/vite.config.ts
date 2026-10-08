import tailwindcss from '@tailwindcss/vite';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { DEV_PORT } from './src/lib/atproto/port';
import { sveltekitOG } from '@ethercorps/sveltekit-og/plugin';

/** `--mode devnet` (pnpm dev:devnet) runs atmo against a local atproto devnet (see
 *  src/lib/atproto/server/devnet.ts). Every other mode defines nothing, so DEVNET is undefined
 *  there and each devnet branch is dropped from the build. (Defined false, it would show up in
 *  every bare import.meta.env a build inlines.) The devnet's URLs have no default and must be on
 *  this machine, so devnet mode cannot be pointed at the real network. */
function devnetDefines(mode: string, command: string): Record<string, string> {
	if (mode !== 'devnet') {
		if (process.env.DEVNET_BINDINGS) {
			throw new Error(
				'DEVNET_BINDINGS is set outside devnet mode: run `pnpm dev:devnet` or unset it'
			);
		}
		return {};
	}
	if (command === 'serve' && !process.env.DEVNET_BINDINGS) {
		throw new Error('run `pnpm dev:devnet`, which also points the dev bindings at the devnet');
	}
	const url = (name: string) => {
		const value = process.env[name] ?? '';
		const host = URL.canParse(value) ? new URL(value).hostname : '';
		if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
			throw new Error(`vite --mode devnet needs ${name} set to the devnet's URL on this machine`);
		}
		return JSON.stringify(value);
	};
	return {
		'import.meta.env.DEVNET': 'true',
		'import.meta.env.DEVNET_PLC_URL': url('DEVNET_PLC_URL'),
		'import.meta.env.DEVNET_PDS_URL': url('DEVNET_PDS_URL')
	};
}

export default defineConfig(({ mode, command }) => ({
	plugins: [sveltekit(), tailwindcss(), sveltekitOG()],
	define: devnetDefines(mode, command),
	server: {
		host: '127.0.0.1',
		port: DEV_PORT,
		// A loopback sign-in returns to exactly this port, so devnet mode never drifts off it.
		...(mode === 'devnet' && { strictPort: true }),
		allowedHosts: ['described-yamaha-fame-social.trycloudflare.com']
	}
}));

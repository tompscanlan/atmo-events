// atmo's dev server as the groups snowglobe serves it: behind the globe's nginx, which ends TLS at
// https://atmo.app.<domain> and passes plain http on. SvelteKit's dev server takes a request's
// scheme from Vite's server.https, so with this plugin it sees the https address the browser uses,
// and the sign-in library's same-origin check (Origin against event.url.origin) holds as in
// production. Hot reload is off: nginx does not pass its websocket on.
import { defineConfig, mergeConfig, type Plugin, type UserConfig } from 'vite';
import app from '../vite.config.ts';

const behindTls: Plugin = {
	name: 'groups-e2e-behind-tls',
	configureServer(server) {
		server.config.server.https = {};
	}
};

export default defineConfig(async (env) => {
	const base = (typeof app === 'function' ? await app(env) : app) as UserConfig;
	return mergeConfig(base, { plugins: [behindTls], server: { hmr: false } });
});

import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';

/** Off unless a deployment names a group host. The URL itself stays config. */
export function groupsEnabled(): boolean {
	return Boolean(env.GROUP_HOST_URL?.trim());
}

/** With groups off, a group address answers as one this site never had: a 404 with SvelteKit's
 *  own message for that, which the error page words as it does for any unknown address. */
export function requireGroupsEnabled(): void {
	if (!groupsEnabled()) error(404, 'Not Found');
}

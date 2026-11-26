import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';

/** Off unless a deployment names a group host. The URL itself stays config. Turning groups back
 *  off takes their permission out of people's sign-in, so, as with private events, anyone who
 *  granted it can't be asked for a new permission until they sign in again. */
export function groupsEnabled(): boolean {
	return Boolean(env.GROUP_HOST_URL?.trim());
}

/** With groups off, a group address answers as one this site never had: a 404 with SvelteKit's
 *  own message for that, which the error page words as it does for any unknown address. */
export function requireGroupsEnabled(): void {
	if (!groupsEnabled()) error(404, 'Not Found');
}

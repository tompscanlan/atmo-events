import { env } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import { parseGroupHostUrl } from '../host-url';

/** The setting last found not to be a URL, so each wrong value is logged once per isolate, not on
 *  every request. */
let reported: string | null = null;

/** The group host's URL, or null with groups off: when no group host is named, or the setting is
 *  not an http(s) URL, which is logged rather than failing every group page. */
export function groupHostUrl(): URL | null {
	const raw = env.GROUP_HOST_URL;
	const url = parseGroupHostUrl(raw);
	if (!url && raw?.trim() && reported !== raw) {
		reported = raw;
		console.error('[groups] GROUP_HOST_URL is not an http(s) URL, so groups are off');
	}
	return url;
}

/** Off unless a deployment names a group host. The URL itself stays config. Turning groups back
 *  off takes their permission out of people's sign-in, so, as with private events, anyone who
 *  granted it can't be asked for a new permission until they sign in again. */
export function groupsEnabled(): boolean {
	return groupHostUrl() !== null;
}

/** With groups off, a group address answers as one this site never had: a 404 with SvelteKit's
 *  own message for that, which the error page words as it does for any unknown address. A groups
 *  command, a remote function, answers otherwise: SvelteKit sends its address to the command
 *  before any of this site's code can tell it apart, so with groups off it answers 200 with an
 *  error inside, this 404 for a well-formed call, SvelteKit's own 400 for one whose payload does
 *  not parse and its 500 for a GET, where an address this site never had answers 404. */
export function requireGroupsEnabled(): void {
	if (!groupsEnabled()) error(404, 'Not Found');
}

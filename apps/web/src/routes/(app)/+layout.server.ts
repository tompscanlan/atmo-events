import { env } from 'cloudflare:workers';

// Optional, so a page's data without it still type-checks: unset reads as off.
export function load(): { groupsEnabled?: boolean } {
	return { groupsEnabled: Boolean(env.GROUP_HOST_URL) };
}

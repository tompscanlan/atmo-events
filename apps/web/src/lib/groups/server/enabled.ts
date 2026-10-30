import { env } from 'cloudflare:workers';

/** Off unless a deployment names a group host. The URL itself stays config. */
export function groupsEnabled(): boolean {
	return Boolean(env.GROUP_HOST_URL?.trim());
}

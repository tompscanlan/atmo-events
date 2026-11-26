import { building, dev } from '$app/env';
import { env } from 'cloudflare:workers';
import type { Handle } from '@sveltejs/kit/hooks';
import { getAuth } from '#lib/atproto/server/oauth.js';

import { restoreDevTunnelOrigin } from '#lib/atproto/server/origin.js';
import { gateGroupRoutes } from '#lib/groups/reroute.js';
import { groupsEnabled } from '#lib/groups/server/enabled.js';

// With groups off, their addresses answer as ones this site never had. The reroute hook in hooks.ts
// does that; it runs in the browser too, so it is told here whether groups are on.
gateGroupRoutes(groupsEnabled);

// The library owns OAuth routes, signed cookies, restoration, and revocation.
export const handle: Handle = (input) => {
	if (building) return input.resolve(input.event);
	if (dev) restoreDevTunnelOrigin(input.event.url, env.OAUTH_PUBLIC_URL);
	return getAuth().handle(input);
};

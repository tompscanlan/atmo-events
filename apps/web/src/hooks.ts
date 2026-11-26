import type { Reroute } from '@sveltejs/kit/hooks';
import { rerouteGroups } from '#lib/groups/reroute.js';

// With groups off, their addresses match no route (see lib/groups/reroute.ts).
export const reroute: Reroute = ({ url }) => rerouteGroups(url.pathname);

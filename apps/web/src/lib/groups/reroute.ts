// With groups off, no route matches a groups address: its pages, their form actions and the group
// sign-in endpoints. SvelteKit then answers it, for every method, as it answers an address this site
// never had, because to SvelteKit it is one. A route that matched could only answer with an error of
// its own, which is not the same answer. A part of groups left out of this build (./build.ts) has
// its addresses answer so too, with groups on or off.
//
// `reroute` is the one hook that runs before SvelteKit matches a route, and it runs in the browser
// too, where the Worker's settings can't be read. So the server hooks hand it the switch with
// `gateGroupRoutes(groupsEnabled)`; in the browser nothing is handed over and nothing is rerouted
// but the parts left out of the build.
import { CREATE_IN_THIS_BUILD } from './build';

/** Every address of `routes/(app)/groups/**` and `routes/oauth/group/**`. */
const GROUP_ADDRESS = /^\/(?:groups|oauth\/group)(?:\/|$)/;

/** Every address of `routes/(app)/groups/create/**`. */
const CREATE_ADDRESS = /^\/groups\/create(?:\/|$)/;

/** Whether the address is one of a part left out of this build. */
function leftOut(path: string): boolean {
	return !CREATE_IN_THIS_BUILD && CREATE_ADDRESS.test(path);
}

/** A path no route matches: a route folder in parentheses never becomes part of an address. */
export const NO_ROUTE = '/(groups-off)';

let groupsEnabled = (): boolean => true;

export function gateGroupRoutes(enabled: () => boolean): void {
	groupsEnabled = enabled;
}

export function rerouteGroups(pathname: string): string | undefined {
	let path: string;
	try {
		// Decoded as SvelteKit decodes it before matching, so /%67roups is /groups here too.
		path = pathname.split('%25').map(decodeURI).join('%25');
	} catch {
		// SvelteKit answers an address it can't decode with a 400 of its own, whatever it is.
		return undefined;
	}
	if (!GROUP_ADDRESS.test(path)) return undefined;
	if (!groupsEnabled()) return NO_ROUTE;
	return leftOut(path) ? NO_ROUTE : undefined;
}

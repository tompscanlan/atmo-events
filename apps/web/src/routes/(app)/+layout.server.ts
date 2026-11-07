import { groupsEnabled } from '#lib/groups/server/enabled.js';
import { privateEventsEnabled } from '#lib/private-events/server/enabled.js';

// Optional, so a page's data without them still type-checks: unset reads as off. Groups are left out
// unless on, so with them off every page's data is what it was without them.
export function load(): { privateEventsEnabled?: boolean; groupsEnabled?: boolean } {
	return {
		privateEventsEnabled: privateEventsEnabled(),
		...(groupsEnabled() ? { groupsEnabled: true } : {})
	};
}

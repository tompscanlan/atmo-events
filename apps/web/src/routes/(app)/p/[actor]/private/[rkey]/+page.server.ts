import { singleEvent } from '#lib/private-events/ids.js';
import { holdsCalendarGrant } from '#lib/private-events/scopes.js';
import { readSpaceEventPage } from '#lib/private-events/server/calendars.js';
import { loadEventPage } from '#lib/private-events/server/event-page.js';

/** Byte for byte, so someone kept out can't tell an event that exists from one that doesn't, or from
 *  one that was cancelled. */
const EVENT_NOT_AVAILABLE =
	"This event isn't available. It may have been cancelled, or you may not be on its guest list.";

// Reading it asks the host's server, which learns who is asking and when. A guest was once asked to
// choose that first; it cost every guest a click on every event, so the read is direct. Once its
// host names its space, it shows as an event on that calendar, at this same address.
export function load(event) {
	return loadEventPage(event, EVENT_NOT_AVAILABLE, async (caller, host) => {
		const found = await readSpaceEventPage(caller, singleEvent(host, event.params.rkey));
		if (!found) return null;
		// Naming its space makes its guests a shared calendar, which asks for one more permission.
		const canName =
			caller.did === host && !found.calendar && holdsCalendarGrant(caller.scope, caller.did);
		return { ...found, canName };
	});
}

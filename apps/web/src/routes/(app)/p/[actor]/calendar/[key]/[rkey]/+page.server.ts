import { calendarEvent } from '#lib/private-events/ids.js';
import { readCalendarEventPage } from '#lib/private-events/server/calendars.js';
import { loadEventPage } from '#lib/private-events/server/event-page.js';

/** Byte for byte, so someone kept out can't tell an event that exists from one that doesn't, or from
 *  one that was cancelled. */
const EVENT_NOT_AVAILABLE =
	"This event isn't available. It may have been cancelled, or you may not be on its calendar.";

export function load(event) {
	const { key, rkey } = event.params;
	return loadEventPage(event, EVENT_NOT_AVAILABLE, (caller, host) =>
		readCalendarEventPage(caller, calendarEvent(host, key, rkey))
	);
}

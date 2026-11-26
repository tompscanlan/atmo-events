// With groups on, a member's own PDS lists their group's calendar space, once they have RSVPed
// there, among the calendar spaces "your private events" reads. It is keyed `self`, as a group's
// spaces are, and holds the group's events rather than one of its own: read for an event keyed
// `self`, it has none, and a group never writes one there. So it is read as any other listed space,
// and drops out as one without an event does.
import { CALENDAR_SPACE_TYPE } from '../calendar';
import { SPACE_SKEY } from '../ids';
import { groupsEnabled } from './enabled';

/** Whether a listed calendar space whose read failed may be a group's calendar, which leaves no
 *  event out: only with groups on, never the person's own, and only one keyed `self`. Each address
 *  form gives the same parts: an `at:space/…` one is never read for the list at all. */
export function mayBeGroupCalendar(
	callerDid: string,
	space: { authority: string; type: string; key: string }
): boolean {
	return (
		groupsEnabled() &&
		space.authority !== callerDid &&
		space.type === CALENDAR_SPACE_TYPE &&
		space.key === SPACE_SKEY
	);
}

// Which of a group's calendar spaces its members-only events go in, noted in KV beside the group's
// other notes when members-only events are turned on here: the group's own `self` one unless
// another app made the group a calendar first, which is then used instead. Nothing here asks the
// group host; whoever acts on the space checks it there (./group-events.ts).
import { env } from 'cloudflare:workers';
import { calendarSkeyOf, calendarSpaceUri } from '../calendar';

const CHOSEN_PREFIX = 'group:calendar:';

/** The space noted for the group, if one is, and it is one of the group's calendar spaces. */
export async function rememberedCalendar(groupDid: string): Promise<string | null> {
	const kept = await env.OAUTH_SESSIONS?.get(CHOSEN_PREFIX + groupDid, 'text');
	return kept && calendarSkeyOf(kept, groupDid) !== null ? kept : null;
}

/** The group's calendar space for members-only events: the one noted, or else `self`. */
export async function chosenCalendar(groupDid: string): Promise<string> {
	return (await rememberedCalendar(groupDid)) ?? calendarSpaceUri(groupDid);
}

export async function rememberCalendar(groupDid: string, space: string): Promise<void> {
	if (calendarSkeyOf(space, groupDid) === null)
		throw new Error('not one of the group calendar spaces');
	await env.OAUTH_SESSIONS?.put(CHOSEN_PREFIX + groupDid, space);
}

/** Back to `self`, for a noted space the host no longer has. */
export async function forgetCalendar(groupDid: string): Promise<void> {
	await env.OAUTH_SESSIONS?.delete(CHOSEN_PREFIX + groupDid);
}

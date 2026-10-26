import { hasEnded } from '$lib/past-events';
import type { GroupEventRecord } from './types';

/** A group's events in time, as its pages list them. */
export interface GroupSchedule {
	/** Not over yet, soonest first, so an event under way leads. */
	upcoming: GroupEventRecord[];
	/** Over, most recent first. An event with no start can't be placed and closes the list. */
	past: GroupEventRecord[];
}

function startOf(event: GroupEventRecord): number {
	const startsAt = event.value.startsAt;
	const ms = typeof startsAt === 'string' ? Date.parse(startsAt) : NaN;
	return Number.isNaN(ms) ? -Infinity : ms;
}

function byUri(a: GroupEventRecord, b: GroupEventRecord): number {
	return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0;
}

/** Splits `events` at `asOf` (an ISO instant) by the rule the profile's past events use. */
export function scheduleGroupEvents(events: GroupEventRecord[], asOf: string): GroupSchedule {
	const upcoming: GroupEventRecord[] = [];
	const past: GroupEventRecord[] = [];
	for (const event of events) {
		const startsAt = event.value.startsAt;
		const over =
			startOf(event) === -Infinity ||
			hasEnded(
				{
					startsAt: startsAt as string,
					endsAt: typeof event.value.endsAt === 'string' ? event.value.endsAt : undefined
				},
				asOf
			);
		(over ? past : upcoming).push(event);
	}
	// -Infinity minus itself is NaN, which falls through to the URI.
	upcoming.sort((a, b) => startOf(a) - startOf(b) || byUri(a, b));
	past.sort((a, b) => startOf(b) - startOf(a) || byUri(a, b));
	return { upcoming, past };
}

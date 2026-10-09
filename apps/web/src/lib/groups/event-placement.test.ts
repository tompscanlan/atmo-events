import { describe, expect, it } from 'vitest';
import {
	PLACEMENT_FIXED,
	PLACEMENT_OPTIONS,
	PLACEMENT_QUESTION,
	EVENT_PLACEMENTS,
	placementLabel,
	placementOf
} from './event-placement';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;

describe('who can see a group event', () => {
	// A save sends the answer itself, and the writer turns `members` into the
	// group's calendar space, so the page holds no space URI at all.
	it('the two answers are the options the page offers, in order', () => {
		expect(PLACEMENT_OPTIONS.map((o) => o.value)).toEqual([...EVENT_PLACEMENTS]);
		expect(PLACEMENT_OPTIONS.map((o) => o.label)).toEqual(['Everyone', 'Members only']);
	});

	// The edit page reads where the event is and shows it read-only.
	it("the group's repo reads as Everyone and its calendar space as Members only", () => {
		expect(placementOf(null)).toBe('everyone');
		expect(placementOf(CALENDAR)).toBe('members');
		expect(placementLabel(null)).toBe('Everyone');
		expect(placementLabel(CALENDAR)).toBe('Members only');
	});

	it('the words are the agreed copy, and none of them calls the event private', () => {
		expect(PLACEMENT_QUESTION).toBe('Who can see this event');
		expect(PLACEMENT_OPTIONS).toEqual([
			{
				value: 'everyone',
				label: 'Everyone',
				help: 'Anyone can see it, including people outside the group.'
			},
			{
				value: 'members',
				label: 'Members only',
				help: "Only the group's members can see it. It can't be switched to Everyone later. For now it has no recurring copies and its image isn't shown. The Public / Unlisted setting below doesn't apply."
			}
		]);
		expect(PLACEMENT_FIXED).toBe("This can't be changed after the event is published.");
		const words = [
			PLACEMENT_QUESTION,
			PLACEMENT_FIXED,
			...PLACEMENT_OPTIONS.flatMap(Object.values)
		];
		expect(words.filter((w) => /\bprivate\b/i.test(w))).toEqual([]);
	});
});

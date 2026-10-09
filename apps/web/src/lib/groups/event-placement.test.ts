import { describe, expect, it } from 'vitest';
import {
	PLACEMENT_FIXED,
	PLACEMENT_OPTIONS,
	PLACEMENT_QUESTION,
	placementLabel,
	placementOf
} from './event-placement';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/rsvp.atmo.group.calendar/self`;

describe('who can see a group event', () => {
	// The edit page reads where the event is and shows it read-only.
	it("the group's repo reads as Everyone and its calendar space as Members only", () => {
		expect(placementOf(null)).toBe('everyone');
		expect(placementOf(CALENDAR)).toBe('members');
		expect(placementLabel(null)).toBe('Everyone');
		expect(placementLabel(CALENDAR)).toBe('Members only');
	});

	// The words say "members only" and promise no more than that: the group, and
	// who goes to its public events, can still be found. (Spec: FR-108.)
	it('no word the page shows calls the event private', () => {
		const words = [
			PLACEMENT_QUESTION,
			PLACEMENT_FIXED,
			...PLACEMENT_OPTIONS.flatMap(Object.values)
		];
		expect(words.filter((w) => /\bprivate\b/i.test(w))).toEqual([]);
	});
});

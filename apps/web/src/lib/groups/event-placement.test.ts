import { describe, expect, it } from 'vitest';
import {
	PLACEMENT_FIXED,
	PLACEMENT_OPTIONS,
	PLACEMENT_QUESTION,
	placementLabel,
	placementSpace,
	type EventPlacement
} from './event-placement';

const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
// Written out, so a wrong type or key in the app's constant fails here.
const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;

describe('who can see a group event', () => {
	it("Everyone is the group's public repo and Members only is its calendar space", () => {
		expect(placementSpace('everyone', CALENDAR)).toBeNull();
		expect(placementSpace('members', CALENDAR)).toBe(CALENDAR);
		// Each label the page offers, to the space a save under it sends.
		expect(PLACEMENT_OPTIONS.map((o) => [o.label, placementSpace(o.value, CALENDAR)])).toEqual([
			['Everyone', null],
			['Members only', CALENDAR]
		]);
		// And back, for the edit page's read-only line.
		expect(placementLabel(null)).toBe('Everyone');
		expect(placementLabel(CALENDAR)).toBe('Members only');
	});

	// The server accepts null from anyone, so an answer the page did not mean
	// must never come out as the public repo.
	it('an answer that is neither is refused, never read as Everyone', () => {
		for (const answer of [undefined, null, '', 'Everyone', 'public', 'members-only']) {
			expect(() => placementSpace(answer as unknown as EventPlacement, CALENDAR)).toThrow();
		}
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

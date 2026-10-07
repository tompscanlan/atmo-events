// Who can see a group event, as the group's event pages ask and answer it. A
// members-only event is written into the group's calendar space and a public
// one into the group's repo, so the answer is where the event goes, not a field
// on the record. (Spec: FR-103.)
//
// The words live here beside the mapping, so the new-event and edit pages say
// the same thing. They say "members only" and promise no more than that: the
// group itself, and who goes to its public events, can still be found.
// (Spec: FR-108.)

/** The question's two answers. The new-event page holds no answer until one is
 *  picked, and there is no default: a public post can't be taken back. */
export type EventPlacement = 'everyone' | 'members';

export const PLACEMENT_QUESTION = 'Who can see this event';

export interface PlacementOption {
	value: EventPlacement;
	label: string;
	help: string;
}

export const PLACEMENT_OPTIONS: readonly PlacementOption[] = [
	{
		value: 'everyone',
		label: 'Everyone',
		help: 'Anyone can see it, including people outside the group.'
	},
	{
		value: 'members',
		label: 'Members only',
		// The last sentence is about the editor's own Public / Unlisted switch,
		// which only sets whether a public event is listed in discovery.
		help: "Only the group's members can see it. It can't be switched to Everyone later. For now it has no recurring copies and its image isn't shown. The Public / Unlisted setting below doesn't apply."
	}
];

/** Under the edit page's answer: the writer refuses to move an event between
 *  the group's repo and its calendar space. (Spec: FR-107.) */
export const PLACEMENT_FIXED = "This can't be changed after the event is published.";

/**
 * The space a save under this answer sends: null for the group's repo, or the
 * calendar space URI the page's loader computed from the group's DID. The
 * server accepts null from anyone, so any other answer throws rather than fall
 * through to public.
 */
export function placementSpace(choice: EventPlacement, calendarSpaceUri: string): string | null {
	if (choice === 'members') return calendarSpaceUri;
	if (choice === 'everyone') return null;
	throw new Error(`not an answer to "${PLACEMENT_QUESTION}": ${String(choice)}`);
}

/** The answer an event's space gives, for a page that shows it read-only. */
export function placementLabel(space: string | null): string {
	return space === null ? 'Everyone' : 'Members only';
}

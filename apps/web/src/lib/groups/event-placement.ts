// Who can see a group event. A members-only event is written into the group's calendar
// space and a public one into its repo, so the answer is where the event goes, never a field.

/** No default: a public post can't be taken back. */
export const EVENT_PLACEMENTS = ['everyone', 'members'] as const;
export type EventPlacement = (typeof EVENT_PLACEMENTS)[number];

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
		// The last sentence is about the editor's Public / Unlisted switch, which only lists a public event.
		help: "Only the group's members can see it. It can't be switched to Everyone later. For now it has no recurring copies and its image isn't shown. The Public / Unlisted setting below doesn't apply."
	}
];

/** Moving an event between the repo and the calendar space would change its URI. */
export const PLACEMENT_FIXED = "This can't be changed after the event is published.";

export function placementOf(space: string | null | undefined): EventPlacement {
	return space ? 'members' : 'everyone';
}

export function placementLabel(space: string | null | undefined): string {
	return placementOf(space) === 'everyone' ? 'Everyone' : 'Members only';
}

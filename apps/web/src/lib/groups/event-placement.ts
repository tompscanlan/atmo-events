// Who can see a group event. A members-only event is written into the group's calendar
// space and a public one into its repo, so the answer is where the event goes, never a field.
// Values only, so the pages can import them.

/** No default: a public post can't be taken back. */
export const EVENT_PLACEMENTS = ['everyone', 'members'] as const;
export type EventPlacement = (typeof EVENT_PLACEMENTS)[number];

export const PLACEMENT_OPTIONS: readonly { value: EventPlacement; label: string; help: string }[] =
	[
		{
			value: 'everyone',
			label: 'Everyone',
			help: 'Anyone can see it, including people outside the group.'
		},
		{
			value: 'members',
			label: 'Members only',
			// The last sentence is about the editor's Public / Unlisted switch, which lists only
			// a public event.
			help: "Only the group's members can see it, and it can't be made public later. It has no image or recurring copies for now. The Public / Unlisted setting doesn't apply."
		}
	];

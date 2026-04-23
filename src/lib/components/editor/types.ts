import type { EventTheme } from '$lib/theme';

export type EventMode = 'inperson' | 'virtual' | 'hybrid';
export type Visibility = 'public' | 'private' | 'unlisted';

export interface EventLocation {
	street?: string;
	locality?: string;
	region?: string;
	country?: string;
}

export interface EventDraft {
	name: string;
	description: string;
	startsAt: string;
	endsAt: string;
	timezone?: string;
	theme?: EventTheme;
	links: Array<{ uri: string; name: string }>;
	mode?: EventMode;
	visibility?: Visibility;
	thumbnailKey?: string;
	thumbnailChanged?: boolean;
	location?: EventLocation | null;
	locationChanged?: boolean;
}

export function stripModePrefix(modeStr: string): EventMode {
	const stripped = modeStr.replace('community.lexicon.calendar.event#', '');
	if (stripped === 'virtual' || stripped === 'hybrid' || stripped === 'inperson') return stripped;
	return 'inperson';
}

export function getLocationDisplayString(loc: EventLocation): string {
	return [loc.street, loc.locality, loc.region, loc.country].filter(Boolean).join(', ');
}

export type EventMode = 'inperson' | 'virtual' | 'hybrid';
export type Visibility = 'public' | 'private' | 'unlisted';

export interface EventLocationCoords {
	lat: number;
	lng: number;
}

export interface EventLocation {
	/**
	 * The picked place's own name (e.g. "Humboldt Park", "Alinea"), when the
	 * geocoder result has one that the address fields don't already state. A named
	 * area counts, not just a venue.
	 */
	name?: string;
	street?: string;
	locality?: string;
	region?: string;
	country?: string;
	/**
	 * Geocoder coordinates for the picked place. Kept OFF the address entry (the
	 * lexicon address has no lat/lng) and emitted as a companion geo entry by
	 * {@link buildLocationEntries}, so authored records carry a searchable _geo.
	 */
	coords?: EventLocationCoords;
}

/**
 * Optional autofill payload for a brand-new event. EventEditor populates its
 * fields from this on mount (only when there is no `eventData`), while leaving
 * `isNew` true so the save path still treats the result as a creation. Use
 * `additionalData` to carry atmo-specific extras (e.g. an external source link
 * + rsvp mode) into the saved record.
 */
export interface EventEditorPrefill {
	name?: string;
	description?: string;
	/** ISO 8601 string. */
	startsAt?: string;
	/** ISO 8601 string. */
	endsAt?: string;
	timezone?: string;
	mode?: EventMode;
	location?: EventLocation;
	links?: Array<{ uri: string; name: string }>;
	additionalData?: Record<string, unknown>;
	/**
	 * Pre-supplied cover image. When set, the editor uses this instead of
	 * auto-generating a preset thumbnail and the file is uploaded as a blob on
	 * save.
	 */
	thumbnailFile?: File;
}

export function stripModePrefix(modeStr: string): EventMode {
	const stripped = modeStr.replace('community.lexicon.calendar.event#', '');
	if (stripped === 'virtual' || stripped === 'hybrid' || stripped === 'inperson') return stripped;
	return 'inperson';
}

export function getLocationDisplayString(loc: EventLocation): string {
	const parts = [loc.name, loc.street, loc.locality, loc.region, loc.country].filter(Boolean);
	if (parts.length > 0) return parts.join(', ');
	// A pick the geocoder gave no ISO country code for is stored as coordinates
	// only — the address lexicon requires a country — so show the point instead of
	// an empty label. Rounded for display; the stored coordinates are untouched.
	if (loc.coords) return `${loc.coords.lat.toFixed(5)}, ${loc.coords.lng.toFixed(5)}`;
	return '';
}

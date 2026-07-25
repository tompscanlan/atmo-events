import { marked } from 'marked';
import { sanitize } from '../cal/sanitize.js';
import { getProfileUrl } from '../profile-url.js';
import { locationSummary } from '../location-summary.js';
import type { FlatEventRecord } from '../contrail.js';

export function formatMonth(date: Date): string {
	return date.toLocaleDateString('en-US', { month: 'short' }).toUpperCase();
}

export function formatDay(date: Date): number {
	return date.getDate();
}

export function formatWeekday(date: Date): string {
	return date.toLocaleDateString('en-US', { weekday: 'long' });
}

export function formatFullDate(date: Date): string {
	const options: Intl.DateTimeFormatOptions = { month: 'long', day: 'numeric' };
	if (date.getFullYear() !== new Date().getFullYear()) {
		options.year = 'numeric';
	}
	return date.toLocaleDateString('en-US', options);
}

export function formatTime(date: Date): string {
	return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export function getModeLabel(mode: string): string {
	if (mode.includes('virtual')) return 'Virtual';
	if (mode.includes('hybrid')) return 'Hybrid';
	if (mode.includes('inperson')) return 'In-Person';
	return 'Event';
}

/** Foxui accent-color class — applied alongside `variant="primary"` on a Badge
 *  to override its `--accent-*` CSS variables (see @foxui/core/dist/theme.css). */
export function getModeColor(mode: string): string {
	if (mode.includes('virtual')) return 'cyan';
	if (mode.includes('hybrid')) return 'purple';
	if (mode.includes('inperson')) return 'amber';
	return '';
}

export type LocationData = {
	name?: string;
	shortAddress: string;
	fullAddress: string;
	fullString: string;
	googleMapsUrl: string;
};

/** Display form for a bare point, matching what the editor shows for the same
 *  record. Rounded for display only; the stored coordinates are untouched. */
function formatCoords(lat: string | undefined, lng: string | undefined): string {
	const latitude = Number(lat);
	const longitude = Number(lng);
	if (!lat || !lng || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return '';
	return `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
}

export function getLocationData(locations: FlatEventRecord['locations']): LocationData | null {
	const summary = locationSummary(locations);
	if (!summary) return null;

	const fullParts = [summary.street, summary.locality, summary.region, summary.country].filter(
		Boolean
	);
	// No address fields — a place saved as a geo entry alone. Show its name, or the
	// point itself when it has none, which is what the editor shows for the same
	// record. Returning null here would render no location and no map for a record
	// that does have a position.
	if (fullParts.length === 0) {
		const point = summary.lat && summary.lng ? `${summary.lat},${summary.lng}` : '';
		const label = summary.name || formatCoords(summary.lat, summary.lng);
		if (!label) return null;
		return {
			name: summary.name,
			shortAddress: '',
			fullAddress: '',
			fullString: label,
			googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(point || label)}`
		};
	}

	const shortAddress = [summary.street, summary.locality].filter(Boolean).join(', ');
	const fullAddress = fullParts.join(', ');
	const fullString = summary.name ? `${summary.name}, ${fullAddress}` : fullAddress;
	const googleMapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(fullString)}`;

	return { name: summary.name, shortAddress, fullAddress, fullString, googleMapsUrl };
}

export type GeoLocation = {
	lat: number;
	lng: number;
	googleMapsUrl: string;
	osmUrl: string;
};

function geoUrls(lat: number, lng: number, osmType?: string, osmId?: number) {
	return {
		googleMapsUrl: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`,
		osmUrl:
			osmType && osmId
				? `https://www.openstreetmap.org/${osmType}/${osmId}`
				: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`
	};
}

export async function resolveGeoLocation(
	locations: FlatEventRecord['locations'],
	locationData: LocationData | null
): Promise<GeoLocation | null> {
	if (!locations?.length) return null;

	const geo = locations.find((v) => v.$type === 'community.lexicon.location.geo') as
		| { latitude?: string; longitude?: string }
		| undefined;
	if (geo?.latitude && geo?.longitude) {
		const lat = parseFloat(geo.latitude);
		const lng = parseFloat(geo.longitude);
		if (!isNaN(lat) && !isNaN(lng)) return { lat, lng, ...geoUrls(lat, lng) };
	}

	if (!locationData?.fullAddress) return null;

	try {
		const r = await fetch(`/api/geocoding?q=${encodeURIComponent(locationData.fullAddress)}`);
		if (!r.ok) return null;
		// /api/geocoding returns a normalized { lat, lng, label, ... } shape.
		const data = (await r.json()) as {
			lat?: number;
			lng?: number;
			osmType?: string;
			osmId?: number;
		} | null;
		if (typeof data?.lat !== 'number' || typeof data?.lng !== 'number') return null;
		const lat = data.lat;
		const lng = data.lng;
		if (isNaN(lat) || isNaN(lng)) return null;
		return { lat, lng, ...geoUrls(lat, lng, data.osmType, data.osmId) };
	} catch {
		return null;
	}
}

const renderer = new marked.Renderer();
renderer.link = ({ href, text }) =>
	`<a target="_blank" rel="noopener noreferrer nofollow" href="${href}" class="text-accent-600 dark:text-accent-400 hover:underline">${text}</a>`;

type Facet = {
	index: { byteStart: number; byteEnd: number };
	features: { $type: string; did?: string; uri?: string; tag?: string }[];
};

function renderDescription(text: string, facets?: Facet[]): string {
	let result = text;

	if (facets && facets.length > 0) {
		const encoded = new TextEncoder().encode(text);
		const decoder = new TextDecoder();

		const sorted = [...facets].sort((a, b) => a.index.byteStart - b.index.byteStart);

		const parts: string[] = [];
		let cursor = 0;

		for (const facet of sorted) {
			const feature = facet.features?.[0];
			if (!feature) continue;
			if (facet.index.byteStart < cursor) continue;

			const segmentText = decoder.decode(
				encoded.slice(facet.index.byteStart, facet.index.byteEnd)
			);

			let mdLink: string | null = null;
			switch (feature.$type) {
				case 'app.bsky.richtext.facet#mention': {
					const handle = segmentText.startsWith('@') ? segmentText.slice(1) : segmentText;
					mdLink = `[${segmentText}](${getProfileUrl(handle || feature.did || '')})`;
					break;
				}
				case 'app.bsky.richtext.facet#link':
					mdLink = `[${segmentText}](${feature.uri})`;
					break;
				case 'app.bsky.richtext.facet#tag':
					mdLink = `[${segmentText}](https://bsky.app/hashtag/${feature.tag})`;
					break;
			}

			if (mdLink) {
				parts.push(decoder.decode(encoded.slice(cursor, facet.index.byteStart)));
				parts.push(mdLink);
				cursor = facet.index.byteEnd;
			}
		}

		parts.push(decoder.decode(encoded.slice(cursor)));
		result = parts.join('');
	}

	return marked.parse(result, { renderer }) as string;
}

export function buildDescriptionHtml(
	description: string | undefined,
	facets: unknown
): string | null {
	if (!description) return null;
	return sanitize(renderDescription(description, facets as Facet[] | undefined), {
		ADD_ATTR: ['target']
	});
}

// Side-by-side location-label comparison: main (before) vs PR 66 (after).
//
// The NEW labels come from the branch's real module, imported below — not a
// reimplementation. The OLD labels are transcribed verbatim from main and the
// source is printed in the report so the transcription is auditable:
//   card       -> getLocationString  in packages/ui/src/EventCard.svelte
//   event page -> getLocationData    in packages/ui/src/event-view/format.ts
//
// Usage: node --import <tsx> loc-compare.ts <dump-dir> <out-dir>

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationShortLabel, locationFullLabel, locationSummary } from '../../packages/ui/src/location-summary.js';

const ADDRESS = 'community.lexicon.location.address';
const GEO = 'community.lexicon.location.geo';

type Entry = { $type?: string; [k: string]: unknown };

// ---- OLD, from main -------------------------------------------------------

/** main: packages/ui/src/EventCard.svelte — the label in a LIST of events. */
function oldCardLabel(locations: Entry[] | undefined): string | undefined {
	if (!locations?.length) return undefined;
	const loc = locations.find((v) => v.$type === ADDRESS) as
		| { locality?: string; region?: string }
		| undefined;
	if (!loc) return undefined;
	return [loc.locality, loc.region].filter(Boolean).join(', ') || undefined;
}

/** main: packages/ui/src/event-view/format.ts — the event page / exports. */
function oldFullLabel(locations: Entry[] | undefined): string | undefined {
	if (!locations?.length) return undefined;
	const loc = locations.find((v) => v.$type === ADDRESS) as
		| { name?: string; street?: string; locality?: string; region?: string; country?: string }
		| undefined;
	if (!loc) return undefined;
	const fullParts = [loc.street, loc.locality, loc.region, loc.country].filter(Boolean);
	if (fullParts.length === 0) return undefined;
	const fullAddress = fullParts.join(', ');
	const displayName = loc.name || undefined;
	return displayName ? `${displayName}, ${fullAddress}` : fullAddress;
}

// ---- shape classification -------------------------------------------------

/** Bucket a record by the shape of its locations[], so the sample can span the
 *  spectrum rather than 200 near-identical city records. */
function classify(locations: Entry[]): string {
	const address = locations.find((l) => l?.$type === ADDRESS) as Record<string, unknown> | undefined;
	const geo = locations.find((l) => l?.$type === GEO) as Record<string, unknown> | undefined;
	const other = locations.filter((l) => l?.$type !== ADDRESS && l?.$type !== GEO);

	const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
	const aName = s(address?.name);
	const aStreet = s(address?.street);
	const aLocality = s(address?.locality);
	const aRegion = s(address?.region);
	const aCountry = s(address?.country);
	const gName = s(geo?.name);
	const lat = s(geo?.latitude);
	const lng = s(geo?.longitude);

	const zeroish =
		lat !== undefined && lng !== undefined && Number(lat) === 0 && Number(lng) === 0;

	if (!address && !geo) return other.length ? 'other-entry-kinds-only' : 'empty';
	if (!address && geo) {
		if (zeroish) return 'geo-only-0,0-sentinel';
		if (gName) return 'geo-only-named (no ISO country)';
		return 'geo-only-bare-point';
	}
	if (address && !geo) {
		if (!aName) return 'address-no-name-no-geo';
		return 'address-named-no-geo';
	}
	// address + geo
	if (zeroish) return 'address+geo-0,0-sentinel';
	if (!aName) return 'address-no-name+geo';
	// is the name a whole reverse-geocoded string?
	if (aName.split(',').length >= 3) return 'address-name-is-full-address+geo';
	if (aName.length > 40) return 'address-long-name+geo';
	if (aLocality && aName.toLowerCase() === aLocality.toLowerCase())
		return 'address-name-repeats-locality+geo';
	if (aLocality && aRegion && aLocality.toLowerCase() === aRegion.toLowerCase())
		return 'address-city-state (locality=region)+geo';
	if (aStreet && !aLocality) return 'address-street-no-locality+geo';
	if (!aCountry) return 'address-named-no-country+geo';
	return 'address-named-place+geo';
}

// ---- run ------------------------------------------------------------------

const dumpDir = process.argv[2];
const outDir = process.argv[3];

type Row = {
	uri: string;
	title: string | null;
	mode: string | null;
	shape: string;
	locations: Entry[];
	summary: ReturnType<typeof locationSummary>;
	oldCard?: string;
	newCard?: string;
	oldFull?: string;
	newFull?: string;
	cardChanged: boolean;
	fullChanged: boolean;
};

const rows: Row[] = [];
const seenUri = new Set<string>();

for (const file of readdirSync(dumpDir).filter((f) => f.startsWith('page-'))) {
	const parsed = JSON.parse(readFileSync(join(dumpDir, file), 'utf8'));
	// wrangler --json wraps results as [{ results: [...] }]
	const results = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(
		(r: { results?: unknown[] }) => r.results ?? []
	) as Array<{ uri: string; title: string | null; locations: string | null; mode: string | null }>;

	for (const r of results) {
		if (!r.locations || seenUri.has(r.uri)) continue;
		seenUri.add(r.uri);
		let locations: Entry[];
		try {
			locations = JSON.parse(r.locations);
		} catch {
			continue;
		}
		if (!Array.isArray(locations)) continue;

		const oldCard = oldCardLabel(locations);
		const newCard = locationShortLabel(locations);
		const oldFull = oldFullLabel(locations);
		const newFull = locationFullLabel(locations);

		rows.push({
			uri: r.uri,
			title: r.title,
			mode: r.mode,
			shape: classify(locations),
			locations,
			summary: locationSummary(locations),
			oldCard,
			newCard,
			oldFull,
			newFull,
			cardChanged: (oldCard ?? '') !== (newCard ?? ''),
			fullChanged: (oldFull ?? '') !== (newFull ?? '')
		});
	}
}

// ---- summary stats --------------------------------------------------------

const byShape = new Map<string, Row[]>();
for (const row of rows) {
	if (!byShape.has(row.shape)) byShape.set(row.shape, []);
	byShape.get(row.shape)!.push(row);
}

const stats = {
	totalRecords: rows.length,
	cardLabelChanged: rows.filter((r) => r.cardChanged).length,
	fullLabelChanged: rows.filter((r) => r.fullChanged).length,
	cardGainedALabel: rows.filter((r) => !r.oldCard && r.newCard).length,
	cardLostALabel: rows.filter((r) => r.oldCard && !r.newCard).length,
	shapes: [...byShape.entries()]
		.map(([shape, rs]) => ({
			shape,
			count: rs.length,
			cardChanged: rs.filter((r) => r.cardChanged).length
		}))
		.sort((a, b) => b.count - a.count)
};

writeFileSync(join(outDir, 'stats.json'), JSON.stringify(stats, null, 2));
writeFileSync(join(outDir, 'all-rows.json'), JSON.stringify(rows, null, 2));

// A spectrum sample: up to N per shape, preferring rows where the card changed
// (those are the demo), but always including at least one unchanged example per
// shape so "no regression" cases are visible too.
const PER_SHAPE = Number(process.env.PER_SHAPE ?? 3);
const sample: Row[] = [];
for (const [, rs] of byShape) {
	const changed = rs.filter((r) => r.cardChanged);
	const same = rs.filter((r) => !r.cardChanged);
	sample.push(...changed.slice(0, PER_SHAPE));
	if (changed.length < PER_SHAPE) sample.push(...same.slice(0, PER_SHAPE - changed.length));
	else if (same.length) sample.push(same[0]);
}
writeFileSync(join(outDir, 'sample.json'), JSON.stringify(sample, null, 2));

console.log(JSON.stringify(stats, null, 2));
console.log(`\nsample rows: ${sample.length}  (PER_SHAPE=${PER_SHAPE})`);

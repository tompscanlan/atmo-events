// Does a SIMPLER rule set produce better output than PR 66's current logic?
// Measured over the same 5,022 records, scored against main as the baseline.
//
// PR 66 today carries three pieces of machinery:
//   compactPlaceName  — trim a long name to a 40-char budget, with a house-number/
//                       postcode heuristic (namesAPlace, CODE_MAX_LENGTH) plus a
//                       run-on branch and a trim-back branch
//   dropRepeats       — progressive whole-comma-segment de-duplication of the name
//                       AND of the context fields against each other
//   locationSummary   — fold the address entry and the companion geo entry
//
// locationSummary is where essentially all the value is: it is what lets a record
// whose name lives on the geo entry render at all. The other two are cosmetic
// polish, and both reported bugs live in them.
//
// The simple variant below keeps locationSummary verbatim and replaces the other
// two with two one-line predicates:
//   R1  De-duplicate the NAME against the context fields only. Never de-duplicate
//       the context fields against EACH OTHER — a city that shares its state's name
//       ("New York, New York", "Québec, Québec") is a conventional label, not a
//       repetition, and dropping half of it makes the place more ambiguous.
//   R2  A name containing a comma IS already an address. Emit it alone rather than
//       appending fields to it. Replaces the segment-matching that could not see
//       "CO" inside "CO 80123".
//   R3  No length budget and no trimming. The card truncates in CSS, at the real
//       pixel boundary, which needs no heuristic about what a segment means.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';
import { locationShortLabel, locationFullLabel } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];

type Entry = { $type?: string; [k: string]: unknown };
const ADDRESS = 'community.lexicon.location.address';

// ---- main (before) --------------------------------------------------------
function mainCard(locations: Entry[]): string | undefined {
	if (!locations?.length) return undefined;
	const loc = locations.find((v) => v.$type === ADDRESS) as
		| { locality?: string; region?: string }
		| undefined;
	if (!loc) return undefined;
	return [loc.locality, loc.region].filter(Boolean).join(', ') || undefined;
}
function mainFull(locations: Entry[]): string | undefined {
	if (!locations?.length) return undefined;
	const loc = locations.find((v) => v.$type === ADDRESS) as
		| { name?: string; street?: string; locality?: string; region?: string; country?: string }
		| undefined;
	if (!loc) return undefined;
	const parts = [loc.street, loc.locality, loc.region, loc.country].filter(Boolean);
	if (!parts.length) return undefined;
	return loc.name ? `${loc.name}, ${parts.join(', ')}` : parts.join(', ');
}

// ---- simple variant ------------------------------------------------------

/** R1: is this context field already stated by the name? Whole-comma-segment match,
 *  the same test PR 66 uses — but applied ONLY name-vs-field, never field-vs-field. */
function statedByName(name: string, field: string): boolean {
	const segs = name.split(',').map((s) => s.trim().toLowerCase());
	return segs.includes(field.trim().toLowerCase());
}

/** R2: a multi-segment name is already an address. */
const isAddressLike = (name: string) => name.includes(',');

function simpleCard(locations: Entry[]): string | undefined {
	const s = locationSummary(locations);
	if (!s) return undefined;
	if (!s.name) {
		// Exactly main's label, including a city that shares its state's name.
		const ctx = [s.locality, s.region].filter(Boolean).join(', ');
		return ctx || pointOf(s) || undefined;
	}
	// R3: no trimming. R2: an address-like name stands alone.
	if (isAddressLike(s.name)) return s.name;
	const ctx = [s.locality, s.region]
		.filter((v): v is string => Boolean(v))
		.filter((v) => !statedByName(s.name!, v));
	return ctx.length ? `${s.name}, ${ctx.join(', ')}` : s.name;
}

function simpleFull(locations: Entry[]): string | undefined {
	const s = locationSummary(locations);
	if (!s) return undefined;
	if (!s.name) {
		const ctx = [s.street, s.locality, s.region, s.country].filter(Boolean).join(', ');
		return ctx || pointOf(s) || undefined;
	}
	if (isAddressLike(s.name)) return s.name;
	const ctx = [s.street, s.locality, s.region, s.country]
		.filter((v): v is string => Boolean(v))
		.filter((v) => !statedByName(s.name!, v));
	return ctx.length ? `${s.name}, ${ctx.join(', ')}` : s.name;
}

function pointOf(s: { lat?: string; lng?: string }): string | undefined {
	if (!s.lat || !s.lng) return undefined;
	const la = Number(s.lat),
		ln = Number(s.lng);
	if (!Number.isFinite(la) || !Number.isFinite(ln)) return undefined;
	if (la === 0 && ln === 0) return undefined;
	if (Math.abs(la) > 90 || Math.abs(ln) > 180) return undefined;
	return `${la.toFixed(5)}, ${ln.toFixed(5)}`;
}

// ---- score ---------------------------------------------------------------

type Row = { uri: string; title: string | null; shape: string; locations: Entry[] };
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const segs = (s: string | undefined) =>
	(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** The CO-80123 defect signature: a later segment repeated as a token inside an
 *  earlier one. */
function redundantTail(label: string | undefined): boolean {
	const p = segs(label);
	for (let i = 1; i < p.length; i++) {
		const c = p[i].toLowerCase();
		for (let j = 0; j < i; j++) {
			const toks = p[j].toLowerCase().split(/\s+/);
			if (toks.includes(c) && p[j].toLowerCase() !== c) return true;
		}
	}
	return false;
}

const score = { pr66: blank(), simple: blank() };
function blank() {
	return {
		cardChanged: 0,
		cardGained: 0,
		cardLost: 0,
		cardLostInfoVsMain: 0,
		fullChanged: 0,
		fullRedundantTail: 0,
		cityStateKept: 0,
		cardLenMax: 0,
		cardLenP95: [] as number[]
	};
}

for (const r of rows) {
	const mc = mainCard(r.locations),
		mf = mainFull(r.locations);
	const s = locationSummary(r.locations);
	const cityState = Boolean(
		s?.locality && s?.region && s.locality.toLowerCase() === s.region.toLowerCase()
	);

	for (const [key, card, full] of [
		['pr66', locationShortLabel(r.locations), locationFullLabel(r.locations)],
		['simple', simpleCard(r.locations), simpleFull(r.locations)]
	] as Array<['pr66' | 'simple', string | undefined, string | undefined]>) {
		const t = score[key];
		if ((mc ?? '') !== (card ?? '')) t.cardChanged++;
		if (!mc && card) t.cardGained++;
		if (mc && !card) t.cardLost++;
		// main's label is not a substring-preserved subset of the new one => info lost
		if (mc && card && mc.length > card.length) t.cardLostInfoVsMain++;
		if ((mf ?? '') !== (full ?? '')) t.fullChanged++;
		if (redundantTail(full)) t.fullRedundantTail++;
		if (cityState && card && /(.+),\s*\1$/i.test(card)) t.cityStateKept++;
		t.cardLenMax = Math.max(t.cardLenMax, card?.length ?? 0);
		t.cardLenP95.push(card?.length ?? 0);
	}
}

for (const k of ['pr66', 'simple'] as const) {
	const a = score[k].cardLenP95.sort((x, y) => x - y);
	(score[k] as Record<string, unknown>).cardLenP95 = a[Math.floor(a.length * 0.95)];
}

// Where the two variants disagree, so the trade-off is inspectable.
const diffs: Array<Record<string, unknown>> = [];
for (const r of rows) {
	const a = locationShortLabel(r.locations),
		b = simpleCard(r.locations);
	const af = locationFullLabel(r.locations),
		bf = simpleFull(r.locations);
	if ((a ?? '') !== (b ?? '') || (af ?? '') !== (bf ?? '')) {
		diffs.push({
			title: r.title,
			shape: r.shape,
			mainCard: mainCard(r.locations),
			pr66Card: a,
			simpleCard: b,
			mainFull: mainFull(r.locations),
			pr66Full: af,
			simpleFull: bf
		});
	}
}

const uniq = new Map<string, { n: number; d: Record<string, unknown> }>();
for (const d of diffs) {
	const k = `${d.pr66Card}|${d.simpleCard}|${d.pr66Full}|${d.simpleFull}`;
	const hit = uniq.get(k);
	if (hit) hit.n++;
	else uniq.set(k, { n: 1, d });
}

writeFileSync(
	join(outDir, 'simple-score.json'),
	JSON.stringify(
		{ score, diffRecords: diffs.length, diffDistinct: uniq.size,
		  diffs: [...uniq.values()].sort((x, y) => y.n - x.n).slice(0, 30) },
		null,
		2
	)
);

console.log(JSON.stringify(score, null, 2));
console.log(`\nrecords where the two variants differ: ${diffs.length} (${uniq.size} distinct)\n`);
for (const { n, d } of [...uniq.values()].sort((x, y) => y.n - x.n).slice(0, 14)) {
	console.log(`(${n} rec) [${d.shape}] ${String(d.title).slice(0, 46)}`);
	console.log(`   card  main=${JSON.stringify(d.mainCard)}`);
	console.log(`         pr66=${JSON.stringify(d.pr66Card)}`);
	console.log(`       simple=${JSON.stringify(d.simpleCard)}`);
	if (d.pr66Full !== d.simpleFull) {
		console.log(`   full  pr66=${JSON.stringify(d.pr66Full)}`);
		console.log(`       simple=${JSON.stringify(d.simpleFull)}`);
	}
	console.log();
}

// Second pass over the harness output: quantify suspicious NEW labels, and build a
// deduplicated spectrum sample (recurring-event instances repeat the same record
// verbatim, which crowds a demo table with identical rows).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2];
type Row = {
	uri: string;
	title: string | null;
	shape: string;
	locations: Array<Record<string, unknown>>;
	summary: Record<string, string> | null;
	oldCard?: string;
	newCard?: string;
	oldFull?: string;
	newFull?: string;
	cardChanged: boolean;
	fullChanged: boolean;
};
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const segs = (s: string | undefined) =>
	(s ?? '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);

/** A later segment that is already a whitespace token inside an EARLIER segment.
 *  This is the "…, CO 80123, US, CO" class: dropRepeats compares whole comma
 *  segments, so a region embedded in a name segment ("CO 80123") is not seen as a
 *  repeat of the region field ("CO") and gets appended again. */
function redundantTail(label: string | undefined): string | null {
	const parts = segs(label);
	for (let i = 1; i < parts.length; i++) {
		const candidate = parts[i].toLowerCase();
		for (let j = 0; j < i; j++) {
			const tokens = parts[j].toLowerCase().split(/\s+/);
			if (tokens.includes(candidate) && parts[j].toLowerCase() !== candidate) {
				return `"${parts[i]}" already inside "${parts[j]}"`;
			}
		}
	}
	return null;
}

/** Country code stranded before another segment — a full label should end on the
 *  country. Detects the ordering half of the same defect. */
function countryNotLast(label: string | undefined): boolean {
	const parts = segs(label);
	if (parts.length < 2) return false;
	const idx = parts.findIndex((p) => /^[A-Z]{2}$/.test(p) || p === 'United States');
	return idx >= 0 && idx < parts.length - 1;
}

const withRedundantTail = rows.filter((r) => redundantTail(r.newFull));
const oldAlsoRedundant = withRedundantTail.filter((r) => redundantTail(r.oldFull));
const newOnlyRedundant = withRedundantTail.filter((r) => !redundantTail(r.oldFull));
const countryStranded = rows.filter((r) => countryNotLast(r.newFull) && !countryNotLast(r.oldFull));

// Card labels that got LONGER than the 40-char budget the short label promises.
const overBudget = rows.filter((r) => (r.newCard?.length ?? 0) > 40);
// Card label that is now a bare point (last-resort branch).
const pointLabels = rows.filter((r) => /^-?\d+\.\d{5}, -?\d+\.\d{5}$/.test(r.newCard ?? ''));
// Card lost a label (regression) — should be zero.
const lostCard = rows.filter((r) => r.oldCard && !r.newCard);
const lostFull = rows.filter((r) => r.oldFull && !r.newFull);

const report = {
	totalRecords: rows.length,
	suspicious: {
		newFullHasRedundantTail: withRedundantTail.length,
		ofWhichMainAlreadyDidToo: oldAlsoRedundant.length,
		introducedByPR66: newOnlyRedundant.length,
		countryCodeNoLongerLast: countryStranded.length,
		cardOver40Chars: overBudget.length,
		cardIsBarePoint: pointLabels.length,
		cardLostALabel: lostCard.length,
		fullLostALabel: lostFull.length
	},
	examplesIntroducedByPR66: newOnlyRedundant.slice(0, 8).map((r) => ({
		title: r.title,
		uri: r.uri,
		why: redundantTail(r.newFull),
		oldFull: r.oldFull,
		newFull: r.newFull
	})),
	examplesFullLostALabel: lostFull.slice(0, 5).map((r) => ({
		title: r.title,
		uri: r.uri,
		locations: r.locations,
		oldFull: r.oldFull,
		newFull: r.newFull
	})),
	examplesCardOverBudget: overBudget.slice(0, 5).map((r) => ({
		title: r.title,
		len: r.newCard?.length,
		newCard: r.newCard
	}))
};
writeFileSync(join(outDir, 'suspicious.json'), JSON.stringify(report, null, 2));

// ---- deduplicated spectrum sample -----------------------------------------
// Key on the transformation, not the record: recurring instances share a record
// verbatim and would otherwise fill the table with the same before/after pair.
const PER_SHAPE = Number(process.env.PER_SHAPE ?? 4);
const byShape = new Map<string, Row[]>();
for (const r of rows) {
	if (!byShape.has(r.shape)) byShape.set(r.shape, []);
	byShape.get(r.shape)!.push(r);
}

const sample: Row[] = [];
for (const [, rs] of byShape) {
	const seen = new Set<string>();
	const uniq: Row[] = [];
	for (const r of rs) {
		const key = `${r.oldCard ?? ''}→${r.newCard ?? ''}|${r.oldFull ?? ''}→${r.newFull ?? ''}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push(r);
	}
	const changed = uniq.filter((r) => r.cardChanged);
	const same = uniq.filter((r) => !r.cardChanged);
	sample.push(...changed.slice(0, PER_SHAPE));
	if (same.length) sample.push(same[0]);
}
writeFileSync(join(outDir, 'sample-dedup.json'), JSON.stringify(sample, null, 2));

console.log(JSON.stringify(report.totalRecords, null, 2), 'records');
console.log(JSON.stringify(report.suspicious, null, 2));
console.log('\n--- introduced by PR 66 ---');
for (const e of report.examplesIntroducedByPR66) {
	console.log(`\n${e.title}\n  why: ${e.why}\n  before: ${e.oldFull}\n  after : ${e.newFull}`);
}
console.log('\n--- full label lost ---');
for (const e of report.examplesFullLostALabel) {
	console.log(`\n${e.title}\n  before: ${e.oldFull}\n  after : ${e.newFull}`);
}
console.log(`\ndedup sample rows: ${sample.length}`);

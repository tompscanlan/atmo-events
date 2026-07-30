// Third pass: isolate GENUINE regressions — cases where main produced a label and
// PR 66 produced a WORSE one. Gaining a label where main showed nothing is not a
// regression, and a venue name that contains its own city ("OMNOM Birmingham",
// "The Hideout Bristol XSUK") is dropRepeats working as documented: whole-segment
// matching on purpose, so "Paris Street Cafe" does not swallow the locality.
//
// The real defect class is narrower: a field restated INSIDE a name segment
// together with another token, so whole-segment matching cannot see it —
// "CO 80123" vs region "CO" — which appends the region again AFTER the country.

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
};
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const segs = (s: string | undefined) =>
	(s ?? '')
		.split(',')
		.map((x) => x.trim())
		.filter(Boolean);

const isCountry = (p: string) => /^[A-Z]{2}$/.test(p) || /^United States$/i.test(p);

/** The defect: a segment appended AFTER the country segment. A full address ends on
 *  the country; anything past it is a field dropRepeats failed to recognise as
 *  already-present. Anchoring on country position rather than on substring matching
 *  avoids flagging venue names that legitimately contain their city. */
function tailPastCountry(label: string | undefined): string | null {
	const parts = segs(label);
	const idx = parts.findIndex(isCountry);
	if (idx < 0 || idx === parts.length - 1) return null;
	return parts.slice(idx + 1).join(', ');
}

/** Same segment appearing twice outright in the joined label. */
function exactDuplicateSegment(label: string | undefined): string | null {
	const parts = segs(label).map((p) => p.toLowerCase());
	const seen = new Set<string>();
	for (const p of parts) {
		if (seen.has(p)) return p;
		seen.add(p);
	}
	return null;
}

type Defect = { kind: string; detail: string; row: Row };
const defects: Defect[] = [];

for (const r of rows) {
	const hadLabel = Boolean(r.oldFull);

	const past = tailPastCountry(r.newFull);
	if (past && !tailPastCountry(r.oldFull)) {
		defects.push({
			kind: hadLabel ? 'REGRESSION: segment after country' : 'NEW-LABEL wart: segment after country',
			detail: `trailing "${past}"`,
			row: r
		});
	}

	const dupNew = exactDuplicateSegment(r.newFull);
	if (dupNew && !exactDuplicateSegment(r.oldFull)) {
		defects.push({
			kind: hadLabel ? 'REGRESSION: duplicated segment' : 'NEW-LABEL wart: duplicated segment',
			detail: `"${dupNew}" twice`,
			row: r
		});
	}

	// Card label that main filled and PR 66 made materially longer than the budget.
	if (r.oldCard && (r.newCard?.length ?? 0) > 40) {
		defects.push({
			kind: 'card over 40-char budget (had a label before)',
			detail: `${r.newCard?.length} chars`,
			row: r
		});
	}
}

const regressions = defects.filter((d) => d.kind.startsWith('REGRESSION'));
const warts = defects.filter((d) => !d.kind.startsWith('REGRESSION'));

// Group by the transformation so recurring instances collapse.
function group(list: Defect[]) {
	const m = new Map<string, { count: number; d: Defect }>();
	for (const d of list) {
		const key = `${d.kind}|${d.row.oldFull ?? ''}→${d.row.newFull ?? ''}|${d.row.newCard ?? ''}`;
		const hit = m.get(key);
		if (hit) hit.count++;
		else m.set(key, { count: 1, d });
	}
	return [...m.values()].sort((a, b) => b.count - a.count);
}

const gRegress = group(regressions);
const gWarts = group(warts);

const out = {
	totalRecords: rows.length,
	regressionRecords: regressions.length,
	regressionDistinctCases: gRegress.length,
	wartRecords: warts.length,
	wartDistinctCases: gWarts.length,
	regressions: gRegress.map(({ count, d }) => ({
		kind: d.kind,
		detail: d.detail,
		affectedRecords: count,
		title: d.row.title,
		uri: d.row.uri,
		shape: d.row.shape,
		locations: d.row.locations,
		oldCard: d.row.oldCard,
		newCard: d.row.newCard,
		oldFull: d.row.oldFull,
		newFull: d.row.newFull
	})),
	warts: gWarts.slice(0, 10).map(({ count, d }) => ({
		kind: d.kind,
		detail: d.detail,
		affectedRecords: count,
		title: d.row.title,
		oldFull: d.row.oldFull,
		newFull: d.row.newFull
	}))
};
writeFileSync(join(outDir, 'defects.json'), JSON.stringify(out, null, 2));

console.log(
	`records=${out.totalRecords}  REGRESSIONS: ${out.regressionRecords} records / ${out.regressionDistinctCases} distinct  |  new-label warts: ${out.wartRecords} records / ${out.wartDistinctCases} distinct\n`
);
console.log('=== REGRESSIONS (main had a label, PR 66 made it worse) ===');
for (const r of out.regressions) {
	console.log(`\n[${r.kind}] ${r.detail}  (${r.affectedRecords} record(s))`);
	console.log(`  ${r.title}`);
	console.log(`  card  before: ${JSON.stringify(r.oldCard)}  after: ${JSON.stringify(r.newCard)}`);
	console.log(`  full  before: ${JSON.stringify(r.oldFull)}`);
	console.log(`  full  after : ${JSON.stringify(r.newFull)}`);
}
console.log('\n=== top new-label warts (main showed NOTHING; not regressions) ===');
for (const w of out.warts.slice(0, 5)) {
	console.log(`\n[${w.kind}] ${w.detail} (${w.affectedRecords})\n  ${w.title}\n  after: ${w.newFull}`);
}

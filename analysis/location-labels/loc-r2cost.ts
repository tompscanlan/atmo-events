// What does Rule 2 ("a comma-containing name stands alone") actually cost on real
// records? The synthetic test case "Cafe, Paris" + IDF + FR loses both fields. How
// often does a REAL record have an address-like name plus a region or country the
// name does not already state?
//
// Compares the current working tree (R1+R2) against PR 66's stored output.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationFullLabel, locationShortLabel, locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
type Row = {
	title: string | null;
	shape: string;
	locations: Array<Record<string, unknown>>;
	oldCard?: string; // main
	newCard?: string; // PR 66
	oldFull?: string; // main
	newFull?: string; // PR 66
};
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const seg = (s: string | undefined) =>
	(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

let fullChanged = 0;
let lostCountry = 0;
let lostRegion = 0;
let fixedRedundant = 0;
const lostExamples = new Map<string, { n: number; d: Record<string, unknown> }>();
const gainExamples = new Map<string, { n: number; d: Record<string, unknown> }>();

function redundantTail(label: string | undefined): boolean {
	const p = seg(label);
	for (let i = 1; i < p.length; i++) {
		const c = p[i].toLowerCase();
		for (let j = 0; j < i; j++) {
			const toks = p[j].toLowerCase().split(/\s+/);
			if (toks.includes(c) && p[j].toLowerCase() !== c) return true;
		}
	}
	return false;
}

for (const r of rows) {
	const s = locationSummary(r.locations as never);
	const now = locationFullLabel(r.locations as never);
	const pr66 = r.newFull ?? undefined;
	if ((now ?? '') === (pr66 ?? '')) continue;
	fullChanged++;

	const nowSegs = seg(now).map((x) => x.toLowerCase());
	const country = s?.country?.toLowerCase();
	const region = s?.region?.toLowerCase();
	const droppedCountry = Boolean(country && !nowSegs.includes(country) && seg(pr66).map((x) => x.toLowerCase()).includes(country));
	const droppedRegion = Boolean(region && !nowSegs.includes(region) && seg(pr66).map((x) => x.toLowerCase()).includes(region));

	if (droppedCountry) lostCountry++;
	if (droppedRegion) lostRegion++;
	if (redundantTail(pr66) && !redundantTail(now)) fixedRedundant++;

	const bucket = droppedCountry || droppedRegion ? lostExamples : gainExamples;
	const key = `${pr66}|${now}`;
	const hit = bucket.get(key);
	if (hit) hit.n++;
	else
		bucket.set(key, {
			n: 1,
			d: { title: r.title, shape: r.shape, name: s?.name, region: s?.region, country: s?.country, pr66, now }
		});
}

console.log(`full labels changed by R2: ${fullChanged}`);
console.log(`  dropped a country the name did not state: ${lostCountry}`);
console.log(`  dropped a region  the name did not state: ${lostRegion}`);
console.log(`  redundant-tail defects fixed:             ${fixedRedundant}`);

console.log(`\n=== COSTS (a field was lost) — ${[...lostExamples.values()].reduce((n, v) => n + v.n, 0)} records / ${lostExamples.size} distinct ===`);
for (const { n, d } of [...lostExamples.values()].sort((a, b) => b.n - a.n).slice(0, 12)) {
	console.log(`\n(${n} rec) region=${JSON.stringify(d.region)} country=${JSON.stringify(d.country)}`);
	console.log(`   pr66: ${JSON.stringify(d.pr66)}`);
	console.log(`   now : ${JSON.stringify(d.now)}`);
}

console.log(`\n=== BENEFITS (nothing lost) — ${[...gainExamples.values()].reduce((n, v) => n + v.n, 0)} records / ${gainExamples.size} distinct ===`);
for (const { n, d } of [...gainExamples.values()].sort((a, b) => b.n - a.n).slice(0, 8)) {
	console.log(`\n(${n} rec)`);
	console.log(`   pr66: ${JSON.stringify(d.pr66)}`);
	console.log(`   now : ${JSON.stringify(d.now)}`);
}

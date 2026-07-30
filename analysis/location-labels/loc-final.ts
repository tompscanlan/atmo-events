// Final scorecard: working tree (PR 66 + Rule 1) vs PR 66 as-is vs main,
// over all located records.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationFullLabel, locationShortLabel, locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
type Row = {
	title: string | null;
	shape: string;
	locations: Array<Record<string, unknown>>;
	oldCard?: string;
	newCard?: string;
	oldFull?: string;
	newFull?: string;
};
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const norm = (s: string | undefined) => s ?? '';

let cardDiffPr66 = 0,
	fullDiffPr66 = 0,
	gained = 0,
	lostBlank = 0,
	cityStateKept = 0,
	cityStateTotal = 0;

const changes = new Map<string, { n: number; d: Record<string, unknown> }>();

for (const r of rows) {
	const s = locationSummary(r.locations as never);
	const card = locationShortLabel(r.locations as never);
	const full = locationFullLabel(r.locations as never);

	if (!norm(r.oldCard) && card) gained++;
	if (norm(r.oldCard) && !card) lostBlank++;

	const isCityState = Boolean(
		s?.locality && s?.region && s.locality.toLowerCase() === s.region.toLowerCase()
	);
	if (isCityState) {
		cityStateTotal++;
		// both parts still present in whichever label shows them
		const shown = norm(full).toLowerCase();
		const loc = s!.locality!.toLowerCase();
		if (shown.split(',').map((x) => x.trim()).filter((x) => x === loc).length >= 2) cityStateKept++;
	}

	const cardMoved = norm(card) !== norm(r.newCard);
	const fullMoved = norm(full) !== norm(r.newFull);
	if (cardMoved) cardDiffPr66++;
	if (fullMoved) fullDiffPr66++;
	if (cardMoved || fullMoved) {
		const key = `${r.newCard}|${card}|${r.newFull}|${full}`;
		const hit = changes.get(key);
		if (hit) hit.n++;
		else
			changes.set(key, {
				n: 1,
				d: {
					title: r.title,
					shape: r.shape,
					mainCard: r.oldCard,
					pr66Card: r.newCard,
					nowCard: card,
					mainFull: r.oldFull,
					pr66Full: r.newFull,
					nowFull: full
				}
			});
	}
}

const list = [...changes.values()].sort((a, b) => b.n - a.n);
writeFileSync(
	join(outDir, 'final-score.json'),
	JSON.stringify(
		{
			totalRecords: rows.length,
			vsPr66: { cardLabelsChanged: cardDiffPr66, fullLabelsChanged: fullDiffPr66 },
			vsMain: { gainedALabel: gained, wentBlank: lostBlank },
			cityState: { total: cityStateTotal, bothPartsKept: cityStateKept },
			distinctChanges: list.length,
			changes: list.slice(0, 40)
		},
		null,
		2
	)
);

console.log(`records: ${rows.length}`);
console.log(`\nvs PR 66 as-is:`);
console.log(`  card labels changed: ${cardDiffPr66}`);
console.log(`  full labels changed: ${fullDiffPr66}`);
console.log(`  distinct transformations: ${list.length}`);
console.log(`\nvs main (unchanged from PR 66's numbers — the win is preserved):`);
console.log(`  gained a label where main showed nothing: ${gained}`);
console.log(`  went blank: ${lostBlank}`);
console.log(`\ncity-shares-its-state records: ${cityStateTotal}, both parts kept: ${cityStateKept}`);

console.log(`\n=== every distinct change vs PR 66 ===`);
for (const { n, d } of list) {
	console.log(`\n(${n} rec) [${d.shape}] ${String(d.title).slice(0, 50)}`);
	if (d.pr66Card !== d.nowCard) {
		console.log(`  card  main=${JSON.stringify(d.mainCard)}`);
		console.log(`        pr66=${JSON.stringify(d.pr66Card)}`);
		console.log(`         now=${JSON.stringify(d.nowCard)}`);
	}
	if (d.pr66Full !== d.nowFull) {
		console.log(`  full  main=${JSON.stringify(d.mainFull)}`);
		console.log(`        pr66=${JSON.stringify(d.pr66Full)}`);
		console.log(`         now=${JSON.stringify(d.nowFull)}`);
	}
}

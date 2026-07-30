// T3: replace namesAPlace (letter test + digit test + CODE_MAX_LENGTH constant),
// the run-on branch and the trim-back branch with ONE predicate:
//
//     do not END the trimmed label on a segment containing a digit.
//
// Rationale: every segment compactPlaceName wants to trim off the tail is numeric or
// alphanumeric — a house number, a unit number, a postcode ("125", "8 Marina",
// "Unit 12", "W14 9DA", "CO 80123"). A digit anywhere in a TRAILING segment is the
// signal; no length bound and no category list needed. The first segment is always
// kept, so a venue genuinely named with a digit ("Studio 54") is never at risk in
// the lead position.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactPlaceName, locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
type Row = { title: string | null; locations: Array<Record<string, unknown>> };
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const HAS_DIGIT = /\p{Nd}/u;

function trimT3(name: string, max = 40): string {
	if (name.length <= max) return name;
	const segs = name.split(',').map((s) => s.trim()).filter(Boolean);
	if (!segs.length) return name;
	let label = segs[0];
	let taken = 1;
	for (const s of segs.slice(1)) {
		const ext = `${label}, ${s}`;
		if (ext.length > max) break;
		label = ext;
		taken++;
	}
	let end = taken;
	while (end > 1 && HAS_DIGIT.test(segs[end - 1])) end--;
	return segs.slice(0, end).join(', ');
}

let compared = 0,
	agree = 0;
const dis = new Map<string, { n: number; name: string; a: string; b: string }>();

for (const r of rows) {
	const name = locationSummary(r.locations as never)?.name;
	if (!name || name.length <= 40) continue;
	compared++;
	const a = compactPlaceName(name, 40);
	const b = trimT3(name, 40);
	if (a === b) {
		agree++;
		continue;
	}
	const k = `${a}|${b}`;
	const hit = dis.get(k);
	if (hit) hit.n++;
	else dis.set(k, { n: 1, name, a, b });
}

console.log(`names over the budget: ${compared}`);
console.log(`compactPlaceName vs the one-predicate version agree: ${agree} (${((agree / compared) * 100).toFixed(2)}%)`);
console.log(`disagree: ${compared - agree} records / ${dis.size} distinct\n`);
for (const { n, name, a, b } of [...dis.values()].sort((x, y) => y.n - x.n).slice(0, 15)) {
	console.log(`(${n}) ${name.slice(0, 88)}`);
	console.log(`   compactPlaceName : ${JSON.stringify(a)}`);
	console.log(`   one-predicate    : ${JSON.stringify(b)}\n`);
}

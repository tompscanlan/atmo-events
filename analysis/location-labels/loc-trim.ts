// Is compactPlaceName's complexity earning its keep?
//
// It has three parts beyond "keep leading segments while they fit":
//   namesAPlace     — a segment names a place unless it has no letter, or is a SHORT
//                     letter+digit mix (CODE_MAX_LENGTH = 8) i.e. a house number or
//                     postcode
//   run-on branch   — if nothing in reach names a place, run PAST the budget to the
//                     first segment that does
//   trim-back branch— never END on a segment that names nothing ("Nortons Brewing
//                     Company, 125")
//
// T2 below is the same idea with one rule instead of three: keep leading segments
// while they fit, then drop trailing segments that contain no letter. If T2 agrees
// with compactPlaceName on nearly every real record, the extra branches are carrying
// hypothetical cases rather than observed ones.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compactPlaceName, locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
type Row = { title: string | null; shape: string; locations: Array<Record<string, unknown>> };
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const HAS_LETTER = /\p{L}/u;

/** T2: one rule. Keep leading segments while they fit (always at least the first),
 *  then drop trailing segments with no letter in them. */
function trimSimple(name: string, max = 40): string {
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
	// Drop trailing segments that name nothing — a bare house number or postcode.
	let end = taken;
	while (end > 1 && !HAS_LETTER.test(segs[end - 1])) end--;
	return segs.slice(0, end).join(', ');
}

let compared = 0;
let agree = 0;
const disagreements = new Map<string, { n: number; name: string; a: string; b: string }>();

for (const r of rows) {
	const s = locationSummary(r.locations as never);
	const name = s?.name;
	if (!name || name.length <= 40) continue; // trimming only matters above the budget
	compared++;
	const a = compactPlaceName(name, 40);
	const b = trimSimple(name, 40);
	if (a === b) {
		agree++;
		continue;
	}
	const k = `${a}|${b}`;
	const hit = disagreements.get(k);
	if (hit) hit.n++;
	else disagreements.set(k, { n: 1, name, a, b });
}

console.log(`names longer than the 40-char budget: ${compared}`);
console.log(`compactPlaceName and the one-rule version agree: ${agree}  (${((agree / compared) * 100).toFixed(1)}%)`);
console.log(`disagree: ${compared - agree} records, ${disagreements.size} distinct\n`);

for (const { n, name, a, b } of [...disagreements.values()].sort((x, y) => y.n - x.n).slice(0, 20)) {
	console.log(`(${n} rec) name: ${name.slice(0, 92)}`);
	console.log(`   compactPlaceName: ${JSON.stringify(a)}`);
	console.log(`   one-rule        : ${JSON.stringify(b)}`);
	console.log();
}

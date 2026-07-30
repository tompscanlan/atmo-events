// What is CODE_MAX_LENGTH = 8 actually doing?
//
// Two questions the earlier work did not separate:
//   (a) Sensitivity — if the output is identical for a wide range of values, the
//       constant sits in a dead zone and is not "magic" so much as arbitrary-but-safe.
//       If output moves with every step, it is genuinely tuned and fragile.
//   (b) Reach — how often does namesAPlace's letter+digit+length clause decide
//       anything at all, versus the plain "has a letter" test carrying the case?
//
// Reimplements compactPlaceName parameterised by the constant.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;

function namesAPlace(segment: string, codeMax: number): boolean {
	if (!HAS_LETTER.test(segment)) return false;
	return !(HAS_DIGIT.test(segment) && segment.length <= codeMax);
}

function compact(name: string, codeMax: number, maxLength = 40): string {
	if (name.length <= maxLength) return name;
	const segments = name.split(',').map((s) => s.trim()).filter(Boolean);
	if (segments.length === 0) return name;
	let label = segments[0];
	let taken = 1;
	for (const segment of segments.slice(1)) {
		const extended = `${label}, ${segment}`;
		if (extended.length > maxLength) break;
		label = extended;
		taken++;
	}
	if (segments.slice(0, taken).some((s) => namesAPlace(s, codeMax))) {
		let end = taken;
		while (end > 1 && !namesAPlace(segments[end - 1], codeMax)) end--;
		return segments.slice(0, end).join(', ');
	}
	const named = segments.findIndex((s) => namesAPlace(s, codeMax));
	if (named >= taken) {
		const runOn = segments.slice(0, named + 1).join(', ');
		return runOn.length <= name.length ? runOn : name;
	}
	return label;
}

type Row = { locations: Array<Record<string, unknown>> };
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const names: string[] = [];
for (const r of rows) {
	const n = locationSummary(r.locations as never)?.name;
	if (n && n.length > 40) names.push(n);
}

// ---- (a) sensitivity sweep -------------------------------------------------
const baseline = names.map((n) => compact(n, 8));
console.log(`names over the 40-char budget: ${names.length}\n`);
console.log('CODE_MAX_LENGTH sweep — records whose label differs from the value-8 output:');
const sweep: Array<[number, number]> = [];
for (let k = 0; k <= 24; k++) {
	let diff = 0;
	for (let i = 0; i < names.length; i++) if (compact(names[i], k) !== baseline[i]) diff++;
	sweep.push([k, diff]);
	const bar = '█'.repeat(Math.min(60, Math.round(diff / 4)));
	console.log(`  ${String(k).padStart(2)}  ${String(diff).padStart(4)}  ${bar}`);
}

const flat = sweep.filter(([, d]) => d === 0).map(([k]) => k);
console.log(`\nvalues producing IDENTICAL output to 8: ${flat.join(', ') || '(only 8)'}`);

// ---- (b) reach: which clause actually decides? -----------------------------
let segmentsSeen = 0;
let noLetter = 0; // decided by "has no letter" alone
let codeClause = 0; // decided by the letter+digit+length clause
let plainPlace = 0;
const codeExamples = new Map<string, number>();

for (const n of names) {
	for (const raw of n.split(',')) {
		const s = raw.trim();
		if (!s) continue;
		segmentsSeen++;
		if (!HAS_LETTER.test(s)) {
			noLetter++;
			continue;
		}
		if (HAS_DIGIT.test(s) && s.length <= 8) {
			codeClause++;
			codeExamples.set(s, (codeExamples.get(s) ?? 0) + 1);
			continue;
		}
		plainPlace++;
	}
}

console.log(`\nsegments examined: ${segmentsSeen}`);
console.log(`  rejected by "no letter" (bare numbers):        ${noLetter}`);
console.log(`  rejected by the letter+digit+LENGTH clause:    ${codeClause}   <- what the constant governs`);
console.log(`  accepted as naming a place:                    ${plainPlace}`);
console.log(`\nthe segments the constant actually rejects (top 25):`);
for (const [s, n] of [...codeExamples.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
	console.log(`  ${String(n).padStart(4)}x  ${JSON.stringify(s)}  (len ${s.length})`);
}

// What sits just ABOVE the bound — the near-misses that a slightly larger value
// would start rejecting.
const nearMiss = new Map<string, number>();
for (const n of names) {
	for (const raw of n.split(',')) {
		const s = raw.trim();
		if (!s || !HAS_LETTER.test(s) || !HAS_DIGIT.test(s)) continue;
		if (s.length > 8 && s.length <= 14) nearMiss.set(s, (nearMiss.get(s) ?? 0) + 1);
	}
}
console.log(`\njust above the bound (len 9-14, letter+digit) — kept today (top 20):`);
for (const [s, n] of [...nearMiss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
	console.log(`  ${String(n).padStart(4)}x  ${JSON.stringify(s)}  (len ${s.length})`);
}

// Two more rule candidates, both aimed at defects visible in real records rather
// than at hypotheticals.
//
// RULE 2 — collapse consecutive duplicate segments in a name.
//   "Three Pools, Three Pools, Llanvetherine, ..." renders as
//   "Three Pools, Three Pools, Llanvetherine" on a card today. The geocoder emits
//   the venue twice when the feature's name equals its street/area name. Two lines.
//
// RULE 3 — when testing whether a FIELD is already stated by the name, also compare
//   against each name segment with a trailing postal code removed.
//   A segment "CO 80123" states the region CO, but whole-segment matching cannot see
//   it, so the region is appended again after the country. Comparing
//   against the stripped form fixes that WITHOUT dropping the postcode from the
//   output — the .ics export keeps the full address it needs.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];

// ---- postal-code shapes (UK / CA / US) ------------------------------------
const UK = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const CA = /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i;
const US = /^\d{5}(?:-\d{4})?$/;
const isPostcode = (t: string) => UK.test(t) || CA.test(t) || US.test(t);

/** "Bristol BS9 2UN" -> "Bristol", "CO 80123" -> "CO", "London N16 9HP" -> "London".
 *  Tries the last one and last two whitespace tokens, because a UK postcode is two
 *  tokens ("N16 9HP") and a US ZIP is one. Returns null when nothing was stripped. */
function withoutPostcode(segment: string): string | null {
	const toks = segment.split(/\s+/);
	if (toks.length >= 3 && isPostcode(toks.slice(-2).join(' '))) return toks.slice(0, -2).join(' ');
	if (toks.length >= 2 && isPostcode(toks[toks.length - 1])) return toks.slice(0, -1).join(' ');
	return null;
}

/** RULE 2 */
function collapseRepeats(name: string): string {
	const segs = name.split(',').map((s) => s.trim()).filter(Boolean);
	const out: string[] = [];
	for (const s of segs) {
		if (out.length && out[out.length - 1].toLowerCase() === s.toLowerCase()) continue;
		out.push(s);
	}
	return out.join(', ');
}

/** RULE 3 — the set of things a name states, including postcode-stripped forms. */
function statedBy(name: string | undefined): Set<string> {
	const set = new Set<string>();
	for (const raw of (name ?? '').split(',')) {
		const s = raw.trim();
		if (!s) continue;
		set.add(s.toLowerCase());
		const stripped = withoutPostcode(s);
		if (stripped) set.add(stripped.toLowerCase());
	}
	return set;
}

// ---- measure --------------------------------------------------------------
type Row = {
	title: string | null;
	shape: string;
	locations: Array<Record<string, unknown>>;
	oldFull?: string;
	newFull?: string;
	newCard?: string;
};
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

// --- Rule 2 effect ---
const r2 = new Map<string, { n: number; before: string; after: string }>();
for (const r of rows) {
	const name = locationSummary(r.locations as never)?.name;
	if (!name) continue;
	const c = collapseRepeats(name);
	if (c === name) continue;
	const k = `${name}|${c}`;
	const hit = r2.get(k);
	if (hit) hit.n++;
	else r2.set(k, { n: 1, before: name, after: c });
}
const r2total = [...r2.values()].reduce((n, d) => n + d.n, 0);
console.log(`RULE 2 — collapse consecutive duplicate segments`);
console.log(`  affects ${r2total} records / ${r2.size} distinct names\n`);
for (const d of [...r2.values()].sort((a, b) => b.n - a.n).slice(0, 10)) {
	console.log(`  (${d.n}x) ${JSON.stringify(d.before.slice(0, 88))}`);
	console.log(`     ->   ${JSON.stringify(d.after.slice(0, 88))}\n`);
}

// --- Rule 3 effect: which fields become recognised as already-stated ---
console.log(`${'='.repeat(78)}\nRULE 3 — compare fields against postcode-stripped name segments`);
const r3 = new Map<string, { n: number; d: Record<string, unknown> }>();
let r3fields = 0;
for (const r of rows) {
	const s = locationSummary(r.locations as never);
	if (!s?.name) continue;
	const plain = statedBy(s.name);
	const strippedOnly = new Set([...plain]);
	// what the CURRENT code sees (no stripping)
	const current = new Set(
		s.name.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
	);
	const newlyMatched = [s.street, s.locality, s.region, s.country]
		.filter((v): v is string => Boolean(v))
		.filter((v) => strippedOnly.has(v.toLowerCase()) && !current.has(v.toLowerCase()));
	if (!newlyMatched.length) continue;
	r3fields += newlyMatched.length;
	const k = `${s.name}|${newlyMatched.join('+')}`;
	const hit = r3.get(k);
	if (hit) hit.n++;
	else
		r3.set(k, {
			n: 1,
			d: { title: r.title, name: s.name, newlyMatched, pr66Full: r.newFull, mainFull: r.oldFull }
		});
}
const r3total = [...r3.values()].reduce((n, v) => n + v.n, 0);
console.log(`  newly-recognised repeats: ${r3fields} fields across ${r3total} records / ${r3.size} distinct\n`);
for (const { n, d } of [...r3.values()].sort((a, b) => b.n - a.n).slice(0, 12)) {
	console.log(`  (${n}x) name: ${String(d.name).slice(0, 86)}`);
	console.log(`     now recognised as already stated: ${JSON.stringify(d.newlyMatched)}`);
	console.log(`     PR66 full: ${JSON.stringify(d.pr66Full)}`);
	console.log(`     main full: ${JSON.stringify(d.mainFull)}\n`);
}

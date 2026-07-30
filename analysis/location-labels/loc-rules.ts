// The constant is a LENGTH PROXY FOR "IS THIS A POSTCODE". Everything it rejects is
// a UK, Canadian or US postal code — "SN16 0AH", "GL6 0BL", "V2X 2P8", "CA 94110" —
// and the misfires are the segments that are short and alphanumeric but are rooms,
// not codes: "Studio 1", "Studio24", "Rear 6", "Unit 3B".
//
// Rule 2 candidate: say what is meant. Match the postcode shape directly instead of
// guessing from length, which removes the constant AND fixes the misfires.
//
// Rule 3 candidate: a card never displays a country, but a geocoder name almost
// always ends with one ("…, Bristol, UK"), and that tail eats the 40-char budget
// before the city can be reached. Drop a trailing country segment from the name
// before trimming.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';

const outDir = process.argv[2];
const HAS_LETTER = /\p{L}/u;
const HAS_DIGIT = /\p{Nd}/u;

// ---- current -------------------------------------------------------------
function namesAPlaceNow(s: string): boolean {
	if (!HAS_LETTER.test(s)) return false;
	return !(HAS_DIGIT.test(s) && s.length <= 8);
}

// ---- Rule 2: an explicit postal-code shape -------------------------------
// UK  "SW1A 1AA" / "L8 6SE"   CA "V2X 2P8"   US "94110" / "94110-1234"
const UK = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const CA = /^[A-Z]\d[A-Z]\s*\d[A-Z]\d$/i;
const US = /^\d{5}(?:-\d{4})?$/;
const isPostcode = (t: string) => UK.test(t) || CA.test(t) || US.test(t);

function namesAPlaceR2(s: string): boolean {
	if (!HAS_LETTER.test(s)) return false; // a bare house number
	if (isPostcode(s)) return false; // "SN16 0AH", "V2X 2P8"
	// "CA 94110" — a region abbreviation carrying the postcode.
	const toks = s.split(/\s+/);
	if (toks.length === 2 && /^[A-Z]{2}$/.test(toks[0]) && isPostcode(toks[1])) return false;
	return true;
}

// ---- shared trim, parameterised by the predicate -------------------------
function compact(name: string, namesAPlace: (s: string) => boolean, maxLength = 40): string {
	if (name.length <= maxLength) return name;
	const segments = name.split(',').map((s) => s.trim()).filter(Boolean);
	if (!segments.length) return name;
	let label = segments[0];
	let taken = 1;
	for (const seg of segments.slice(1)) {
		const ext = `${label}, ${seg}`;
		if (ext.length > maxLength) break;
		label = ext;
		taken++;
	}
	if (segments.slice(0, taken).some(namesAPlace)) {
		let end = taken;
		while (end > 1 && !namesAPlace(segments[end - 1])) end--;
		return segments.slice(0, end).join(', ');
	}
	const named = segments.findIndex(namesAPlace);
	if (named >= taken) {
		const runOn = segments.slice(0, named + 1).join(', ');
		return runOn.length <= name.length ? runOn : name;
	}
	return label;
}

// ---- Rule 3: drop a trailing country from the name ------------------------
const COUNTRY_TAIL =
	/^(UK|United Kingdom|USA|United States|Canada|CA|Deutschland|Germany|DE|France|FR|España|Spain|Nederland|Netherlands|Italia|Italy|Schweiz|Switzerland|Österreich|Austria|Ireland|Éire|Australia|New Zealand|Norge|Norway|Sverige|Sweden|Danmark|Denmark|Suomi|Finland|Polska|Poland|Portugal|Brasil|Brazil|México|Mexico|Japan|日本)$/i;

function stripCountryTail(name: string): string {
	const segs = name.split(',').map((s) => s.trim()).filter(Boolean);
	if (segs.length > 1 && COUNTRY_TAIL.test(segs[segs.length - 1])) return segs.slice(0, -1).join(', ');
	return name;
}

// ---- measure -------------------------------------------------------------
type Row = { title: string | null; locations: Array<Record<string, unknown>> };
const rows: Row[] = JSON.parse(readFileSync(join(outDir, 'all-rows.json'), 'utf8'));

const names: Array<{ name: string; title: string | null }> = [];
for (const r of rows) {
	const n = locationSummary(r.locations as never)?.name;
	if (n && n.length > 40) names.push({ name: n, title: r.title });
}

function report(
	label: string,
	fn: (n: string) => string,
	base: (n: string) => string
) {
	const diffs = new Map<string, { n: number; before: string; after: string; src: string }>();
	for (const { name } of names) {
		const a = base(name);
		const b = fn(name);
		if (a === b) continue;
		const k = `${a}|${b}`;
		const hit = diffs.get(k);
		if (hit) hit.n++;
		else diffs.set(k, { n: 1, before: a, after: b, src: name });
	}
	const total = [...diffs.values()].reduce((n, d) => n + d.n, 0);
	console.log(`\n${'='.repeat(78)}\n${label}\n  changes ${total} records / ${diffs.size} distinct`);
	for (const d of [...diffs.values()].sort((x, y) => y.n - x.n).slice(0, 14)) {
		console.log(`\n  (${d.n}x) ${d.src.slice(0, 84)}`);
		console.log(`     now : ${JSON.stringify(d.before)}`);
		console.log(`     rule: ${JSON.stringify(d.after)}`);
	}
	return total;
}

const base = (n: string) => compact(n, namesAPlaceNow);

report('RULE 2 — match the postcode shape instead of a length bound', (n) => compact(n, namesAPlaceR2), base);
report('RULE 3 — drop a trailing country from the name before trimming', (n) => compact(stripCountryTail(n), namesAPlaceNow), base);
report('RULE 2 + RULE 3 together', (n) => compact(stripCountryTail(n), namesAPlaceR2), base);

// Sanity: does Rule 2 still reject every postcode the constant rejects?
let stillRejected = 0,
	nowKept: string[] = [];
for (const { name } of names) {
	for (const raw of name.split(',')) {
		const s = raw.trim();
		if (!s) continue;
		if (!namesAPlaceNow(s) && HAS_LETTER.test(s)) {
			if (!namesAPlaceR2(s)) stillRejected++;
			else nowKept.push(s);
		}
	}
}
console.log(`\n${'='.repeat(78)}`);
console.log(`segments the constant rejects that Rule 2 also rejects: ${stillRejected}`);
console.log(`segments the constant rejects that Rule 2 now KEEPS (the misfires it fixes):`);
const kept = new Map<string, number>();
for (const s of nowKept) kept.set(s, (kept.get(s) ?? 0) + 1);
for (const [s, n] of [...kept.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20))
	console.log(`  ${String(n).padStart(4)}x ${JSON.stringify(s)}`);

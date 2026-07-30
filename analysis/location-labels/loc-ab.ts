// A/B: deployed three-rule build (all-rows.json, regenerated) vs PR 66 as-is.
// PR 66's own output is recomputed here from its logic so both sides are exact.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';

const rows = JSON.parse(readFileSync(join(process.argv[2], 'all-rows.json'), 'utf8'));
const ADDRESS = 'community.lexicon.location.address';

// --- PR 66 as-is: dropRepeats WITH progressive accumulation, no cleanName/postcode
function pr66Repeats(name: string | undefined, parts: Array<string | undefined>) {
  const seen = new Set((name ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return parts.map((p) => {
    const v = p?.trim(); if (!v) return undefined;
    const k = v.toLowerCase(); if (seen.has(k)) return undefined;
    seen.add(k); return v;
  }).filter((v): v is string => Boolean(v));
}
function rawSummary(locs: any[]) {
  const a = locs.find((l) => l?.$type === ADDRESS);
  const g = locs.find((l) => l?.$type === 'community.lexicon.location.geo');
  const s = (o: any, k: string) => { const v = o?.[k]; return typeof v === 'string' && v.trim() ? v.trim() : undefined; };
  const out: any = {};
  if (a) { out.name = s(a,'name'); out.street=s(a,'street'); out.locality=s(a,'locality'); out.region=s(a,'region'); out.country=s(a,'country'); }
  if (g) { if (!out.name) out.name = s(g,'name'); }
  return out;
}
function pr66Full(locs: any[]) {
  const s = rawSummary(locs);
  const ctx = pr66Repeats(s.name, [s.street, s.locality, s.region, s.country]);
  const parts = s.name ? [s.name, ...ctx] : ctx;
  return parts.length ? parts.join(', ') : undefined;
}

const segs = (x: string | undefined) => (x ?? '').split(',').map((y) => y.trim()).filter(Boolean);
let betterInfo = 0, lessInfo = 0, dupRemoved = 0, same = 0;
const worse: any[] = [];

for (const r of rows) {
  const now = r.newFull as string | undefined;      // deployed
  const old = pr66Full(r.locations);                 // PR 66
  if ((now ?? '') === (old ?? '')) { same++; continue; }
  const nS = segs(now), oS = segs(old);
  const nSet = new Set(nS.map((x) => x.toLowerCase()));
  const oSet = new Set(oS.map((x) => x.toLowerCase()));
  // a segment PR 66 showed that the deployed build no longer shows at all
  const dropped = [...oSet].filter((x) => !nSet.has(x));
  if (dropped.length) { lessInfo++; worse.push({ t: r.title, old, now, dropped }); }
  else if (nS.length < oS.length) { dupRemoved++; }
  else betterInfo++;
}
console.log(`identical: ${same}`);
console.log(`deployed shows MORE (a field PR 66 dropped): ${betterInfo}`);
console.log(`deployed removed a duplicate segment:        ${dupRemoved}`);
console.log(`deployed shows LESS than PR 66:              ${lessInfo}`);
for (const w of worse.slice(0, 10)) {
  console.log(`\n  ${String(w.t).slice(0,50)}  dropped=${JSON.stringify(w.dropped)}`);
  console.log(`    pr66: ${JSON.stringify(w.old)}`);
  console.log(`    now : ${JSON.stringify(w.now)}`);
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationSummary } from '../../packages/ui/src/location-summary.js';
const rows = JSON.parse(readFileSync(join(process.argv[2], 'all-rows.json'), 'utf8'));
const segsOf = (n: string) => n.split(',').map((s) => s.trim()).filter(Boolean);
let dupOnly = 0, wsOnly = 0, both = 0;
const dupEx = new Map<string, number>();
for (const r of rows) {
  const name = locationSummary(r.locations as never)?.name;
  if (!name) continue;
  const segs = segsOf(name);
  const collapsed: string[] = [];
  for (const s of segs) { if (collapsed.length && collapsed[collapsed.length-1].toLowerCase() === s.toLowerCase()) continue; collapsed.push(s); }
  const hasDup = collapsed.length !== segs.length;
  const hasWs = segs.join(', ') !== name;      // trimming / empty segments / double spaces
  if (hasDup && hasWs) both++; else if (hasDup) dupOnly++; else if (hasWs) wsOnly++;
  if (hasDup) { const k = name.slice(0,80); dupEx.set(k, (dupEx.get(k) ?? 0) + 1); }
}
console.log(`true adjacent-duplicate collapses: ${dupOnly + both} records`);
console.log(`whitespace/empty-segment cleanup only: ${wsOnly} records`);
console.log(`\ndistinct names with a real duplicate (${dupEx.size}):`);
for (const [k, n] of [...dupEx.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(n).padStart(3)}x ${k}`);

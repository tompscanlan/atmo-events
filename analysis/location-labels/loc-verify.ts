import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locationFullLabel, locationShortLabel } from '../../packages/ui/src/location-summary.js';
const rows = JSON.parse(readFileSync(join(process.argv[2], 'all-rows.json'), 'utf8'));
for (const t of ['Free Your AI', 'Three Pools', 'Rest & Restore Sound Bath', 'Worm Time Dialogues', 'Terra Ignota NYC']) {
  const r = rows.find((x: any) => x.title && x.title.includes(t));
  if (!r) { console.log('not found: ' + t); continue; }
  console.log('─'.repeat(78));
  console.log(r.title.slice(0, 60));
  console.log('  card  main=' + JSON.stringify(r.oldCard));
  console.log('        pr66=' + JSON.stringify(r.newCard));
  console.log('         now=' + JSON.stringify(locationShortLabel(r.locations)));
  console.log('  full  main=' + JSON.stringify(r.oldFull));
  console.log('        pr66=' + JSON.stringify(r.newFull));
  console.log('         now=' + JSON.stringify(locationFullLabel(r.locations)));
}

import { readFileSync } from 'node:fs';
import { locationSummary } from '../../packages/ui/src/location-summary.js';
const rows=JSON.parse(readFileSync(process.argv[2]+'/all-rows.json','utf8'));
const ADDRESS='community.lexicon.location.address';
function mainCard(l:any[]){const a=l.find(v=>v.$type===ADDRESS) as any;if(!a)return undefined;return [a.locality,a.region].filter(Boolean).join(', ')||undefined}
function statedByName(n:string,f:string){return n.split(',').map(s=>s.trim().toLowerCase()).includes(f.trim().toLowerCase())}
function simpleCard(l:any[]){const s=locationSummary(l as never);if(!s)return undefined;
 if(!s.name){return [s.locality,s.region].filter(Boolean).join(', ')||undefined}
 if(s.name.includes(','))return s.name;
 const c=[s.locality,s.region].filter(Boolean).filter(v=>!statedByName(s.name!,v as string));
 return c.length?`${s.name}, ${c.join(', ')}`:s.name}
for(const r of rows){const m=mainCard(r.locations),b=simpleCard(r.locations);
 if(m&&b&&m.length>b.length){console.log('TITLE:',r.title);console.log('  locations:',JSON.stringify(r.locations));console.log('  main  :',JSON.stringify(m));console.log('  simple:',JSON.stringify(b));console.log()}}

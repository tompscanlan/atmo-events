// The modules a devnet probe needs to drive atmo's group-host seam against a real
// group host, bundled for Node by ./group-host-adapter.build.mjs. The probe
// (atproto-group-host, spike/probe-day5-3-atmo.mjs and probe-day5-4-atmo.mjs) signs
// people in and reads the host's call log; every decision here is the app's own.
//
// Not deployed, not routed, never imported by the app. `scripts/` is outside
// tsconfig's include, like ./groups-e2e.worker.ts.
export { groupHost } from '../src/lib/groups/server/host';
export { isHostGroup } from '../src/lib/groups/server/host-kind';
export { createGroup, recordGroupSpaces } from '../src/lib/groups/server/db/groups';
export { getMemberRow, pendingRequestIdOf } from '../src/lib/groups/server/db/roster';
export { sqliteD1 } from '../src/lib/groups/server/__fixtures__/d1-sqlite';
export { groupSpaceUris } from '../src/lib/groups/ids';
// Day 5.4 (create at the host): the set-up after the host's sign-up, the reads
// and the repair that check it, and the upload an event image takes.
export { setUpHostGroup } from '../src/lib/groups/create-at-host';
export { getGroupByDid } from '../src/lib/groups/server/db/groups';
export { pdsSpaceReader } from '../src/lib/groups/server/about-read';
export { readGroupMembers } from '../src/lib/groups/server/members-read';
export { repairGroup, describeRepair } from '../src/lib/groups/server/repair';
export { credentialBlobUploader } from '../src/lib/groups/server/event-writer';
export { GROUP_SESSION_SCOPES } from '../src/lib/groups/server/session';

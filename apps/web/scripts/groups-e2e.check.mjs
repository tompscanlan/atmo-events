// Bundles the groups e2e Worker without running it, so a module the worker
// imports that moved or lost an export fails here, with no devnet. Run with the
// type-check as `pnpm check:e2e`.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bundleWorker } from './groups-e2e.build.mjs';

const outDir = await mkdtemp(join(tmpdir(), 'groups-e2e-check-'));
try {
	await bundleWorker(outDir, 'https://plc.invalid');
	console.log('groups e2e worker: bundles');
} finally {
	await rm(outDir, { recursive: true, force: true });
}

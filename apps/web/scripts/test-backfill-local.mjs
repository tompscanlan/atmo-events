import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { getPlatformProxy } from 'wrangler';
import { localD1File } from './backfill-local.mjs';

// The file name copies how workerd names a Durable Object's storage, so check it against the
// file local D1 really writes: a wrangler upgrade that changes the scheme fails here.
test('localD1File names the file local D1 keeps a database in', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'atmo-local-d1-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const databaseId = '2e4b6ea4-6c67-444a-b37d-73594c5b2c01';
	const configPath = join(directory, 'wrangler.json');
	await writeFile(
		configPath,
		JSON.stringify({
			name: 'local-d1-test',
			compatibility_date: '2025-12-25',
			d1_databases: [{ binding: 'DB', database_name: 'local-d1-test', database_id: databaseId }]
		})
	);
	const stateDir = join(directory, 'state');
	const { env, dispose } = await getPlatformProxy({
		configPath,
		persist: { path: join(stateDir, 'v3') }
	});
	try {
		await env.DB.prepare('CREATE TABLE marker (id INTEGER)').run();
	} finally {
		await dispose();
	}
	const file = localD1File(stateDir, databaseId);
	assert.ok(existsSync(file), `expected ${file}`);
	assert.match(file, /71fe1b0db19f63b5ec62864a7eda39e8216bb0fce3fc6e2f3aa471d7548c85c5\.sqlite$/);
});

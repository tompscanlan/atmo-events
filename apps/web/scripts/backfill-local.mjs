// `pnpm backfill:local`: contrail's backfill into the local database the dev server uses, also
// when LOCAL_STATE_DIR keeps it outside .wrangler/state (snowglobe.yml does, for the test
// network). contrail's CLI opens local D1 only in .wrangler/state, but it can write a SQLite file,
// and local D1 keeps each database in one: this hands it that file. Arguments go on to
// `contrail backfill`.
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The SQLite file local D1 keeps a database in, under a state directory (wrangler's
 * --persist-to). workerd names a Durable Object's file by its ID, and local D1 takes the ID from
 * the name `database_id` in the namespace `miniflare-D1DatabaseObject`. */
export function localD1File(stateDir, databaseId) {
	const key = createHash('sha256').update('miniflare-D1DatabaseObject').digest();
	const head = createHmac('sha256', key).update(databaseId).digest().subarray(0, 16);
	const tail = createHmac('sha256', key).update(head).digest().subarray(0, 16);
	const id = Buffer.concat([head, tail]).toString('hex');
	return join(stateDir, 'v3', 'd1', 'miniflare-D1DatabaseObject', `${id}.sqlite`);
}

async function main() {
	const { unstable_readConfig } = await import('wrangler');
	const database = unstable_readConfig({}).d1_databases.find((db) => db.binding === 'DB');
	if (!database?.database_id) throw new Error('wrangler.jsonc has no D1 database bound as DB');
	const stateDir = process.env.LOCAL_STATE_DIR || '.wrangler/state';
	const file = localD1File(resolve(stateDir), database.database_id);
	// Only the dev server creates the file the way local D1 expects it.
	if (!existsSync(file)) {
		console.error(`No local database in ${stateDir} yet: start atmo there once first.`);
		process.exit(1);
	}
	console.log(`backfill: writing ${file}`);
	const config = 'src/lib/contrail/cli.config.ts';
	const args = ['backfill', '--config', config, '--sqlite', file, ...process.argv.slice(2)];
	const { status } = spawnSync('contrail', args, { stdio: 'inherit' });
	process.exit(status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	await main();
}

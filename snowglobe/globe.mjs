#!/usr/bin/env node
// The snowglobe command on this checkout's snowglobe.yml, for the root package's globe:* scripts.
// Snowglobe gives a globe to the first file that runs up for its name and refuses every other
// file that names it, so a second worktree or clone of atmo, whose committed file says the same
// `globe:`, is refused. When the file that holds the globe is another checkout's and says exactly
// what this one says, this runs snowglobe on that file (SG_FILE): the same globe, with this
// checkout's code run against it. A file that says anything else is left to snowglobe, which
// refuses it and says how to give it a globe of its own.
//
//   node snowglobe/globe.mjs <snowglobe command and arguments>
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globeName } from '@openmeet/snowglobe/lib/config.mjs';
import { stateRoot } from '@openmeet/snowglobe/lib/env.mjs';
import { ownerOf } from '@openmeet/snowglobe/lib/state.mjs';

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'snowglobe.yml');
const env = { ...process.env };

if (!env.SG_FILE) {
	let name = '';
	try {
		name = globeName(file);
	} catch {
		// A file with no usable name: snowglobe says what is wrong with it.
	}
	const owner = name ? ownerOf(join(stateRoot(env), name)) : '';
	const same = (other) => readFileSync(other, 'utf8') === readFileSync(file, 'utf8');
	if (owner && owner !== realpathSync(file) && existsSync(owner) && same(owner)) {
		env.SG_FILE = owner;
		console.error(`globe: ${name} is held by ${owner}, which says the same as this file; using it`);
	}
}

const run = spawnSync('snowglobe', process.argv.slice(2), { stdio: 'inherit', env });
if (run.error) throw run.error;
process.exit(run.status ?? 1);

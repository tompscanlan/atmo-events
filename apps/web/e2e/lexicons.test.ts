// Runs with `pnpm test`, not the e2e run. On the local network, a PDS finds lexicons only in this
// folder (snowglobe.yml publishes it), and a sign-in that asks for a permission set it can't find
// fails at the PDS. So every permission set atmo can ask for needs its lexicon here.
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scopes } from '#lib/atproto/settings.js';
import { PRIVATE_CALENDAR_TYPE } from '#lib/private-events/ids.js';

const permissionSets = scopes
	.filter((scope) => scope.startsWith('include:'))
	.map((scope) => scope.slice('include:'.length).split('?')[0]);

const lexiconFile = (nsid: string) =>
	new URL(`./lexicons/${nsid.replaceAll('.', '/')}.json`, import.meta.url);

describe('the e2e network’s lexicons', () => {
	// A copy of the type as Lexicon Community publishes it, so a sign-in that names it resolves.
	it('publish the space type private events use', () => {
		const file = lexiconFile(PRIVATE_CALENDAR_TYPE);
		expect(existsSync(file), `e2e/lexicons has no ${PRIVATE_CALENDAR_TYPE}`).toBe(true);
		expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
			lexicon: 1,
			id: PRIVATE_CALENDAR_TYPE,
			defs: { main: { type: 'space', key: 'any' } }
		});
	});

	it('cover every permission set atmo can ask for', () => {
		expect(permissionSets.length).toBeGreaterThan(0);
		for (const nsid of permissionSets) {
			const file = lexiconFile(nsid);
			expect(existsSync(file), `e2e/lexicons has no ${nsid}`).toBe(true);
			expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
				lexicon: 1,
				id: nsid,
				defs: { main: { type: 'permission-set' } }
			});
		}
	});
});

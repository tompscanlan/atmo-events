// Contrail as the Worker serves it, through the same handler the /xrpc route and the cron use, so
// a deployment with groups off answers like one that never had them.
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createSqliteDatabase } from '@atmo-dev/contrail/sqlite';

vi.mock('../atproto/network', () => ({ contrailNetwork: () => ({}) }));

import { handleContrailRequest } from './index';

const GROUP = 'did:plc:group';
const DECLARATION = `at://${GROUP}/org.atgrp.declaration/self`;
const DECLARED = [
	'rsvp.atmo.declaration.listDeclared',
	'rsvp.atmo.declaration.listDeclared?q=knit',
	`rsvp.atmo.declaration.getRecord?${new URLSearchParams({ uri: DECLARATION })}`,
	'rsvp.atmo.declaration.listRecords'
];

/** A fresh database each time, so the served config is read again. */
async function serve(paths: string[]) {
	const db = createSqliteDatabase(':memory:');
	const answers: string[] = [];
	for (const path of paths) {
		const res = await handleContrailRequest(
			new Request(`https://atmo.example/xrpc/${path}`),
			db as unknown as D1Database
		);
		answers.push(`${res.status} ${await res.text()}`);
	}
	const schema = (await db
		.prepare(
			`SELECT name FROM sqlite_schema WHERE (type = 'table' AND name LIKE 'records_%')
				OR name LIKE 'group%'`
		)
		.all()) as { results: { name: string }[] };
	return { answers, tables: schema.results.map((row) => row.name) };
}

describe('groups declarations as the Worker serves them', () => {
	it('answers rsvp.atmo.declaration.* as an unknown method, and makes no table, with groups off', async () => {
		const off = await serve(['rsvp.atmo.no.suchMethod', ...DECLARED]);
		const [unknown, ...declared] = off.answers;
		expect(unknown).toMatch(/^404 /);
		expect(declared).toEqual(DECLARED.map(() => unknown));
		expect(off.tables).toContain('records_event');
		expect(off.tables).not.toContain('records_declaration');
		expect(off.tables).not.toContain('group_profiles');
		expect(off.tables).not.toContain('groups_event_did_starts');
	});

	it('serves them with groups on, asking no other server, and adds what search needs', async () => {
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		const elsewhere = vi.fn<typeof fetch>();
		vi.stubGlobal('fetch', elsewhere);
		try {
			const on = await serve(DECLARED.slice(0, 2));
			expect(on.answers).toEqual([expect.stringMatching(/^200 /), expect.stringMatching(/^200 /)]);
			expect(on.tables).toEqual(
				expect.arrayContaining(['records_declaration', 'group_profiles', 'groups_event_did_starts'])
			);
			expect(elsewhere).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

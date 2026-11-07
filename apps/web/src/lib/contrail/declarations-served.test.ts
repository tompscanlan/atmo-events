// Contrail as the Worker serves it, through the same handler the /xrpc route and the cron use, so
// a deployment with groups off answers like one that never had them.
import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { createSqliteDatabase } from '@atmo-dev/contrail/sqlite';

vi.mock('../atproto/network', () => ({ contrailNetwork: () => ({}) }));

import { handleContrailRequest } from './index';

const GROUP = 'did:plc:group';
const DECLARATION = `at://${GROUP}/group.opensocial.declaration/self`;
const DECLARED = [
	'rsvp.atmo.declaration.listDeclared',
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
	const tables = (await db
		.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'records_%'")
		.all()) as { results: { name: string }[] };
	return { answers, tables: tables.results.map((row) => row.name) };
}

describe('groups declarations as the Worker serves them', () => {
	it('answers rsvp.atmo.declaration.* as an unknown method, and makes no table, with groups off', async () => {
		const off = await serve(['rsvp.atmo.no.suchMethod', ...DECLARED]);
		const [unknown, ...declared] = off.answers;
		expect(unknown).toMatch(/^404 /);
		expect(declared).toEqual(DECLARED.map(() => unknown));
		expect(off.tables).toContain('records_event');
		expect(off.tables).not.toContain('records_declaration');
	});

	it('serves them with groups on', async () => {
		Object.assign(env, { GROUP_HOST_URL: 'https://host.example' });
		const on = await serve(DECLARED.slice(0, 1));
		expect(on.answers[0]).toMatch(/^200 /);
		expect(on.tables).toContain('records_declaration');
	});

	it('reads an empty or blank GROUP_HOST_URL as off', async () => {
		Object.assign(env, { GROUP_HOST_URL: '  ' });
		const blank = await serve(['rsvp.atmo.no.suchMethod', ...DECLARED.slice(0, 1)]);
		expect(blank.answers[1]).toBe(blank.answers[0]);
	});
});

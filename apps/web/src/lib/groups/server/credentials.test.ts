import { beforeEach, describe, expect, it } from 'vitest';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	resolveGroupCredential,
	storeGroupCredential
} from './credentials';

const DID = 'did:plc:mintedgroupaaaaaaaaaaaaa';
const APP_PASSWORD = 'app-pass-never-at-rest';
const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

let harness: SqliteD1;

beforeEach(() => {
	harness = sqliteD1();
});

describe('minted credential storage', () => {
	it('round-trips a stored credential', async () => {
		const env = { GROUP_CREDENTIAL_KEY: KEY };
		await storeGroupCredential(env, harness.db, DID, {
			service: 'https://pds.example.net',
			identifier: 'kona.group.example.net',
			password: APP_PASSWORD
		});

		const resolved = await resolveGroupCredential(env, harness.db, DID);
		expect(resolved).toEqual({
			service: 'https://pds.example.net',
			identifier: 'kona.group.example.net',
			password: APP_PASSWORD
		});
	});

	// The table is designed so that a D1 read, a backup or
	// `wrangler d1 execute` does not yield a working credential.
	it('never writes the credential in the clear', async () => {
		await storeGroupCredential({ GROUP_CREDENTIAL_KEY: KEY }, harness.db, DID, {
			service: 'https://pds.example.net',
			identifier: 'kona.group.example.net',
			password: APP_PASSWORD
		});

		const row = harness.raw.prepare('SELECT * FROM group_credentials').get() as Record<
			string,
			unknown
		>;
		expect(JSON.stringify(row)).not.toContain(APP_PASSWORD);
		expect(row.secret).toBeTruthy();
		expect(row.iv).toBeTruthy();
	});

	it('gives each write its own nonce', async () => {
		const env = { GROUP_CREDENTIAL_KEY: KEY };
		const cred = {
			service: 'https://pds.example.net',
			identifier: 'kona.group.example.net',
			password: APP_PASSWORD
		};
		await storeGroupCredential(env, harness.db, DID, cred);
		const first = harness.raw.prepare('SELECT iv, secret FROM group_credentials').get() as {
			iv: string;
			secret: string;
		};
		await storeGroupCredential(env, harness.db, DID, cred);
		const second = harness.raw.prepare('SELECT iv, secret FROM group_credentials').get() as {
			iv: string;
			secret: string;
		};

		expect(second.iv).not.toBe(first.iv);
		expect(second.secret).not.toBe(first.secret);
		// One row per DID, replaced. Not an audit log.
		expect(harness.raw.prepare('SELECT COUNT(*) AS n FROM group_credentials').get()).toMatchObject({
			n: 1
		});
	});

	// The row is the only source of a group's credential, so a rotation only
	// has to replace the row.
	it('serves the newest row after a rotation, with nothing able to override it', async () => {
		const env = { GROUP_CREDENTIAL_KEY: KEY };
		await storeGroupCredential(env, harness.db, DID, {
			service: 'https://pds.example.net',
			identifier: 'kona.group.example.net',
			password: APP_PASSWORD
		});
		await storeGroupCredential(env, harness.db, DID, {
			service: 'https://moved.example.net',
			identifier: 'kona.group.example.net',
			password: 'rotated-app-pass'
		});

		await expect(resolveGroupCredential(env, harness.db, DID)).resolves.toEqual({
			service: 'https://moved.example.net',
			identifier: 'kona.group.example.net',
			password: 'rotated-app-pass'
		});
	});

	it('resolves to null for a group this deployment holds nothing for', async () => {
		await expect(
			resolveGroupCredential({ GROUP_CREDENTIAL_KEY: KEY }, harness.db, 'did:plc:unknown')
		).resolves.toBeNull();
	});
});

describe('mint readiness', () => {
	// The create flow asks this before minting: a deployment that cannot store
	// the credential would otherwise leave behind a permanent did:plc.
	it.each([
		['unset', undefined],
		['not base64', '!!!not-base64!!!'],
		['the wrong length', btoa('short')]
	])('reports it cannot mint when the key is %s', async (_label, value) => {
		await expect(canStoreMintedCredentials({ GROUP_CREDENTIAL_KEY: value })).resolves.toBe(false);
	});

	it('reports it can mint with a 32-byte key', async () => {
		await expect(canStoreMintedCredentials({ GROUP_CREDENTIAL_KEY: KEY })).resolves.toBe(true);
	});

	it('refuses to store without a usable key', async () => {
		await expect(
			storeGroupCredential({}, harness.db, DID, {
				service: 'https://pds.example.net',
				identifier: 'kona.group.example.net',
				password: APP_PASSWORD
			})
		).rejects.toThrow(GroupCredentialKeyError);
	});
});

// The group's space credential, and the acceptance reads made with it.
//
// Four rules are tested here:
//
//   1. The signatures are the alpha's HTTP Message Signatures, byte for byte: the
//      base is checked against the migration notes' own example and verified with
//      WebCrypto, not with the code that made it.
//   2. Acceptances are read by DID, each at that member's own PDS and signed for
//      that DID, and never found by listing the space's repos.
//   3. A credential is kept until shortly before it expires, then replaced with a
//      new key. Only a refusal saying the credential is spent replaces it early: a
//      PDS with no spaces support refuses every space call, and must not cost a
//      new credential on every page.
//   4. A group with no linked session has no reader, since the linked session is
//      the only credential this app keeps for a group; a linked one reads through it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { P256PrivateKeyExportable } from '@atcute/crypto';
import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { LINKED_TEST_TOKEN, linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import {
	clearSpaceCredentials,
	credentialAcceptanceReader,
	credentialExpiry,
	exchangeSpaceCredential,
	groupAcceptanceReader,
	spaceSigHeaders,
	type GroupHandle,
	type SpaceHosts,
	type SpaceSigningKey
} from './space-credential';
import { rosterFromRecords, type GroupMembers } from './members-read';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
import { MEMBERS_SPACE_TYPE } from '../types';

import { spaceUri } from '../ids';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const BOB = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const CAROL = 'did:plc:6cz6dldz42itymdbte47ewcv';
const MALLORY = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';
const MEMBERS = spaceUri(GROUP_DID, MEMBERS_SPACE_TYPE, 'self');

const GROUP_HOST = 'https://group.pds.test';
const HOSTS: Record<string, string> = {
	[BOB]: 'https://bob.pds.test',
	[CAROL]: 'https://carol.pds.test',
	[MALLORY]: 'https://mallory.pds.test'
};
const hosts: SpaceHosts = {
	repoHost: async (did) => HOSTS[did] ?? Promise.reject(new Error(`no host for ${did}`)),
	spaceHost: async () => GROUP_HOST
};

function base64url(text: string): string {
	return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A credential-shaped JWT. Only its `exp` is read here. */
function jwt(payload: Record<string, unknown>): string {
	return `${base64url(JSON.stringify({ typ: 'atproto-space-credential+jwt' }))}.${base64url(JSON.stringify(payload))}.c2ln`;
}

/** Which credential the fake issued this one as: 1 for the first. */
function serial(credential: string): number | null {
	try {
		const payload = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		const { n } = JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4))) as {
			n?: unknown;
		};
		return typeof n === 'number' ? n : null;
	} catch {
		return null;
	}
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' }
	});
}

async function verifies(signer: SpaceSigningKey, base: string, header: string): Promise<boolean> {
	const match = /^atproto-space=:([A-Za-z0-9+/=]+):$/.exec(header);
	if (!match) return false;
	const signature = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
	expect(signature.length).toBe(64);
	const publicKey = await crypto.subtle.importKey(
		'jwk',
		await signer.key.exportPublicKey('jwk'),
		{ name: 'ECDSA', namedCurve: 'P-256' },
		false,
		['verify']
	);
	return crypto.subtle.verify(
		{ name: 'ECDSA', hash: 'SHA-256' },
		publicKey,
		signature,
		new TextEncoder().encode(base)
	);
}

async function newSigner(): Promise<SpaceSigningKey> {
	const key = await P256PrivateKeyExportable.createKeypair();
	return { key, keyId: await key.exportPublicKey('did') };
}

describe('spaceSigHeaders', () => {
	it('signs a credential use over the authorization and the audience, as the notes spell it', async () => {
		const signer = await newSigner();
		const headers = await spaceSigHeaders(signer, 'Atproto-Space cred.jwt', BOB);

		expect(headers.authorization).toBe('Atproto-Space cred.jwt');
		expect(headers['atproto-space-audience']).toBe(BOB);
		expect(headers['signature-input']).toBe(
			'atproto-space=("authorization" "atproto-space-audience")'
		);
		// The base, from the migration notes' minimal example.
		const base = [
			'"authorization": Atproto-Space cred.jwt',
			`"atproto-space-audience": ${BOB}`,
			'"@signature-params": ("authorization" "atproto-space-audience")'
		].join('\n');
		expect(await verifies(signer, base, headers.signature)).toBe(true);
	});

	it('signs a delegation token over the authorization alone, and names the key', async () => {
		const signer = await newSigner();
		const headers = await spaceSigHeaders(signer, 'Bearer delegation.jwt');

		expect(signer.keyId).toMatch(/^did:key:zDn/);
		expect(headers['atproto-space-audience']).toBeUndefined();
		expect(headers['signature-input']).toBe(
			`atproto-space=("authorization");keyid="${signer.keyId}"`
		);
		const base = [
			'"authorization": Bearer delegation.jwt',
			`"@signature-params": ("authorization");keyid="${signer.keyId}"`
		].join('\n');
		expect(await verifies(signer, base, headers.signature)).toBe(true);
	});

	it('does not verify against another audience', async () => {
		const signer = await newSigner();
		const headers = await spaceSigHeaders(signer, 'Atproto-Space cred.jwt', BOB);
		const forCarol = [
			'"authorization": Atproto-Space cred.jwt',
			`"atproto-space-audience": ${CAROL}`,
			'"@signature-params": ("authorization" "atproto-space-audience")'
		].join('\n');
		expect(await verifies(signer, forCarol, headers.signature)).toBe(false);
	});
});

describe('credentialExpiry', () => {
	it('reads exp in seconds as epoch ms', () => {
		expect(credentialExpiry(jwt({ exp: 1_791_000_600 }))).toBe(1_791_000_600_000);
	});

	it('is null for a token with no readable exp', () => {
		expect(credentialExpiry('not-a-jwt')).toBeNull();
		expect(credentialExpiry(jwt({ iat: 1 }))).toBeNull();
	});
});

/** A fake of the group's PDS and every member's: the group's session answers
 *  `getDelegationToken`, the group's host exchanges, and each member's host
 *  answers `getRecord` from `accepted`. */
function network(options: {
	accepted?: Set<string>;
	/** A member host's answer, overriding `accepted`. */
	answer?: (did: string, credential: string) => Response | null;
	lifetimeMs?: number;
}) {
	let issued = 0;
	const delegations: string[] = [];
	const exchanges: { headers: Headers; body: unknown }[] = [];
	const reads: { url: URL; headers: Headers }[] = [];
	const others: string[] = [];
	/** The `authorization` each delegation request carried over the global fetch. */
	const delegationAuth: (string | null)[] = [];

	const handle: GroupHandle = async (pathname) => {
		delegations.push(pathname);
		return json(200, { token: `delegation-${delegations.length}` });
	};

	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		// A linked session reaches the group's PDS over the global fetch.
		if (url.pathname === '/xrpc/com.atproto.space.getDelegationToken') {
			delegationAuth.push(headers.get('authorization'));
			return handle(`${url.pathname}${url.search}`, init ?? {});
		}
		if (url.pathname === '/xrpc/com.atproto.space.getSpaceCredential') {
			exchanges.push({ headers, body: JSON.parse(String(init?.body)) });
			issued++;
			const exp = Math.floor((Date.now() + (options.lifetimeMs ?? 600_000)) / 1000);
			return json(200, { credential: jwt({ exp, n: issued }) });
		}
		if (url.pathname === '/xrpc/com.atproto.space.getRecord') {
			reads.push({ url, headers });
			const did = url.searchParams.get('repo') ?? '';
			const credential = (headers.get('authorization') ?? '').replace(/^Atproto-Space /, '');
			const overridden = options.answer?.(did, credential);
			if (overridden) return overridden;
			if (options.accepted?.has(did)) {
				return json(200, {
					uri: `${MEMBERS}/${did}/${GROUP_ACCEPTANCE_COLLECTION}/self`,
					cid: 'bafytest',
					value: { $type: GROUP_ACCEPTANCE_COLLECTION, createdAt: '2026-10-04T10:00:00.000Z' }
				});
			}
			return json(400, { error: 'RecordNotFound', message: 'Could not locate record' });
		}
		others.push(url.toString());
		return json(404, { error: 'NotFound' });
	});

	return {
		handle,
		delegations,
		delegationAuth,
		exchanges,
		reads,
		others,
		issuedCount: () => issued
	};
}

beforeEach(() => clearSpaceCredentials());
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe('exchangeSpaceCredential', () => {
	it('gets a delegation token through the group session, then a credential signed for a new key', async () => {
		const net = network({});
		const cred = await exchangeSpaceCredential(net.handle, MEMBERS, GROUP_HOST);

		expect(net.delegations).toEqual([
			`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space: MEMBERS })}`
		]);
		expect(net.exchanges).toHaveLength(1);
		const [exchange] = net.exchanges;
		expect(exchange.body).toEqual({ space: MEMBERS });
		expect(exchange.headers.get('authorization')).toBe('Bearer delegation-1');
		expect(exchange.headers.get('signature-input')).toBe(
			`atproto-space=("authorization");keyid="${cred.signer.keyId}"`
		);
		const base = [
			'"authorization": Bearer delegation-1',
			`"@signature-params": ("authorization");keyid="${cred.signer.keyId}"`
		].join('\n');
		expect(await verifies(cred.signer, base, exchange.headers.get('signature') ?? '')).toBe(true);
		expect(cred.expiresAt).toBeGreaterThan(Date.now());
	});

	it('throws when the session cannot get a delegation token', async () => {
		network({});
		const refused: GroupHandle = async () => json(400, { error: 'InvalidToken' });
		await expect(exchangeSpaceCredential(refused, MEMBERS, GROUP_HOST)).rejects.toThrow(
			'com.atproto.space.getDelegationToken failed: 400 InvalidToken'
		);
	});
});

describe('reading acceptances by DID', () => {
	it('reads each acceptance at that member’s own PDS, signed for that member', async () => {
		const net = network({ accepted: new Set([BOB]) });
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);

		const answers = await reader.accepted(MEMBERS, [BOB, CAROL]);

		expect([...answers]).toEqual([
			[BOB, true],
			[CAROL, false]
		]);
		expect(net.reads.map((read) => read.url.origin).sort()).toEqual([HOSTS[BOB], HOSTS[CAROL]]);
		for (const read of net.reads) {
			const did = read.url.searchParams.get('repo');
			expect(read.url.searchParams.get('space')).toBe(MEMBERS);
			expect(read.url.searchParams.get('collection')).toBe(GROUP_ACCEPTANCE_COLLECTION);
			expect(read.url.searchParams.get('rkey')).toBe('self');
			expect(read.headers.get('authorization')).toMatch(/^Atproto-Space /);
			expect(read.headers.get('atproto-space-audience')).toBe(did);
			expect(read.headers.get('signature-input')).toBe(
				'atproto-space=("authorization" "atproto-space-audience")'
			);
		}
		// One credential serves every host, and nothing lists the space's repos.
		expect(net.exchanges).toHaveLength(1);
		expect(net.others).toEqual([]);
	});

	it('reads only the DIDs it is given, so an acceptance with no membership never shows', async () => {
		const net = network({ accepted: new Set([BOB, MALLORY]) });
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);
		const members: GroupMembers = {
			memberships: [BOB, CAROL].map((did) => ({
				uri: `${MEMBERS}/${GROUP_DID}/${GROUP_MEMBERSHIP_COLLECTION}/${did}`,
				rkey: did,
				subject: did,
				roles: ['member'],
				createdAt: '2026-10-01T10:00:00.000Z'
			})),
			roles: [],
			permissions: null,
			eventPermissions: null,
			access: null
		};

		const answers = await reader.accepted(
			MEMBERS,
			members.memberships.map((record) => record.subject)
		);
		const roster = rosterFromRecords(members, answers);

		expect(new Map(roster.map((entry) => [entry.did, entry.confirmed]))).toEqual(
			new Map([
				[BOB, true],
				[CAROL, false]
			])
		);
		expect(net.reads.map((read) => read.url.searchParams.get('repo'))).not.toContain(MALLORY);
	});

	it('reads a member whose PDS serves no spaces as unconfirmed, and keeps the credential', async () => {
		const net = network({
			answer: (did) =>
				did === CAROL
					? json(401, { error: 'AuthMissing', message: 'Authentication Required' })
					: null
		});
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);

		expect((await reader.accepted(MEMBERS, [CAROL])).get(CAROL)).toBe(false);
		expect((await reader.accepted(MEMBERS, [CAROL])).get(CAROL)).toBe(false);
		expect(net.exchanges).toHaveLength(1);
	});

	it('reads a member whose DID does not resolve as unconfirmed', async () => {
		const net = network({});
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);
		const answers = await reader.accepted(MEMBERS, ['did:plc:nohostaaaaaaaaaaaaaaaaaa']);
		expect([...answers.values()]).toEqual([false]);
	});

	it('keeps one credential until shortly before it expires, then makes a new key', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
		const net = network({ accepted: new Set([BOB]) });
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);

		await reader.accepted(MEMBERS, [BOB]);
		vi.setSystemTime(new Date('2026-10-04T10:09:00.000Z'));
		await reader.accepted(MEMBERS, [BOB]);
		expect(net.exchanges).toHaveLength(1);

		vi.setSystemTime(new Date('2026-10-04T10:09:45.000Z'));
		await reader.accepted(MEMBERS, [BOB]);
		expect(net.exchanges).toHaveLength(2);
		const keys = net.exchanges.map((e) => e.headers.get('signature-input'));
		expect(keys[0]).not.toBe(keys[1]);
		// Each credential took its own delegation token.
		expect(net.delegations).toHaveLength(2);
	});

	it('replaces a credential a host calls expired, and reads those members again', async () => {
		// The first credential issued is refused as expired; the second is honored.
		const net = network({
			accepted: new Set([BOB]),
			answer: (_did, credential) =>
				serial(credential) === 1
					? json(401, { error: 'JwtExpired', message: 'token expired' })
					: null
		});
		const reader = credentialAcceptanceReader(net.handle, GROUP_DID, hosts);

		const answers = await reader.accepted(MEMBERS, [BOB]);

		expect(answers.get(BOB)).toBe(true);
		expect(net.exchanges).toHaveLength(2);
		expect(net.reads).toHaveLength(2);
	});

	it('throws when no credential can be had, so the page can show no state', async () => {
		network({});
		const refused: GroupHandle = async () => json(400, { error: 'InvalidToken' });
		const reader = credentialAcceptanceReader(refused, GROUP_DID, hosts);
		await expect(reader.accepted(MEMBERS, [BOB])).rejects.toThrow('getDelegationToken');
	});
});

describe('groupAcceptanceReader', () => {
	let harness: SqliteD1;
	beforeEach(() => {
		harness = sqliteD1();
	});
	afterEach(() => {
		harness.close();
		unlinkAllGroups();
	});

	it('has no reader for a group with no credential', async () => {
		expect(await groupAcceptanceReader({}, { group_did: GROUP_DID }, hosts)).toBeNull();
	});

	it('has no reader, and asks nothing, for a group whose owner has not linked it', async () => {
		const env = linkGroups(['did:plc:anothergroupaaaaaaaaaaaa'], GROUP_HOST);
		const fetched = vi.fn();
		vi.stubGlobal('fetch', fetched);
		expect(await groupAcceptanceReader(env, { group_did: GROUP_DID }, hosts)).toBeNull();
		expect(fetched).not.toHaveBeenCalled();
	});

	it('reads through the linked session for a linked group', async () => {
		const env = linkGroups([GROUP_DID], GROUP_HOST);
		const net = network({ accepted: new Set([BOB]) });
		const reader = await groupAcceptanceReader(env, { group_did: GROUP_DID }, hosts);

		expect((await reader!.accepted(MEMBERS, [BOB])).get(BOB)).toBe(true);
		expect(net.delegationAuth).toEqual([`Bearer ${LINKED_TEST_TOKEN}`]);
	});
});

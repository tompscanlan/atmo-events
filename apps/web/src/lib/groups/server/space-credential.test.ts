// A holder's own space credential, and the acceptance reads made with it.
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
//   4. Each holder reads with their own credential, kept per holder and space, so
//      no holder is ever served another's. A refusal that names the holder is
//      `SpaceAccessDenied`, an answer, never an outage.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { P256PrivateKeyExportable } from '@atcute/crypto';
import {
	clearSpaceCredentials,
	credentialAcceptanceReader,
	exchangeSpaceCredential,
	isSpaceAccessDenied,
	SpaceAccessDenied,
	spaceSigHeaders,
	type SpaceHolder,
	type SpaceHosts,
	type SpaceSigningKey
} from './space-credential';
import { credentialSpaceReader } from './about-read';
import { rosterFromRecords, type GroupMembers } from './members-read';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_MEMBERSHIP_COLLECTION } from '../members-record';
import { MEMBERS_SPACE_TYPE } from '../types';

import { spaceUri } from '../ids';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const BOB = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
/** Whose own session reads, unless a test names another holder. */
const VIEWER = 'did:plc:viewerviewerviewerviewer';
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

/** A credential's payload as the fake issued it, or null. */
function payloadOf(credential: string): { n?: unknown; holder?: unknown } | null {
	try {
		const payload = credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
		return JSON.parse(atob(payload + '='.repeat((4 - (payload.length % 4)) % 4)));
	} catch {
		return null;
	}
}

/** Which credential the fake issued this one as: 1 for the first. */
function serial(credential: string): number | null {
	const n = payloadOf(credential)?.n;
	return typeof n === 'number' ? n : null;
}

/** Whose delegation token the fake issued this credential against. */
function holderOf(credential: string): string | null {
	const holder = payloadOf(credential)?.holder;
	return typeof holder === 'string' ? holder : null;
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
});

/** A fake of every holder's PDS and every member's: a holder's session answers
 *  `getDelegationToken` with a token naming them, the group's host exchanges it
 *  for a credential naming them, and each member's host answers `getRecord`
 *  from `accepted`. */
function network(options: {
	accepted?: Set<string>;
	/** A member host's answer, overriding `accepted`. */
	answer?: (did: string, credential: string) => Response | null;
	/** The holder's PDS's answer to a delegation request, overriding the token. */
	delegate?: () => Response | null;
	/** The group host's answer to an exchange, overriding the credential. */
	exchange?: () => Response | null;
	lifetimeMs?: number;
}) {
	let issued = 0;
	const delegations: string[] = [];
	const exchanges: { headers: Headers; body: unknown }[] = [];
	const reads: { url: URL; headers: Headers }[] = [];
	const others: string[] = [];

	/** `did`'s own session. Its delegation tokens name it. */
	const holderFor = (did: string): SpaceHolder => ({
		did,
		handle: async (pathname) => {
			delegations.push(pathname);
			return (
				options.delegate?.() ?? json(200, { token: `delegation-${did}-${delegations.length}` })
			);
		}
	});

	vi.stubGlobal('fetch', async (input: URL | string, init?: RequestInit) => {
		const url = new URL(String(input));
		const headers = new Headers(init?.headers);
		if (url.pathname === '/xrpc/com.atproto.space.getSpaceCredential') {
			exchanges.push({ headers, body: JSON.parse(String(init?.body)) });
			const refused = options.exchange?.();
			if (refused) return refused;
			issued++;
			const exp = Math.floor((Date.now() + (options.lifetimeMs ?? 600_000)) / 1000);
			const holder = /^Bearer delegation-(did:[^-]+)-/.exec(
				headers.get('authorization') ?? ''
			)?.[1];
			return json(200, { credential: jwt({ exp, n: issued, holder }) });
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
		holder: holderFor(VIEWER),
		holderFor,
		delegations,
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
	it("gets a delegation token through the holder's own session, then a credential signed for a new key", async () => {
		const net = network({});
		const cred = await exchangeSpaceCredential(net.holder, MEMBERS, GROUP_HOST);

		expect(net.delegations).toEqual([
			`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space: MEMBERS })}`
		]);
		expect(net.exchanges).toHaveLength(1);
		const [exchange] = net.exchanges;
		expect(exchange.body).toEqual({ space: MEMBERS });
		const token = `delegation-${VIEWER}-1`;
		expect(exchange.headers.get('authorization')).toBe(`Bearer ${token}`);
		expect(exchange.headers.get('signature-input')).toBe(
			`atproto-space=("authorization");keyid="${cred.signer.keyId}"`
		);
		const base = [
			`"authorization": Bearer ${token}`,
			`"@signature-params": ("authorization");keyid="${cred.signer.keyId}"`
		].join('\n');
		expect(await verifies(cred.signer, base, exchange.headers.get('signature') ?? '')).toBe(true);
		expect(cred.expiresAt).toBeGreaterThan(Date.now());
		expect(holderOf(cred.token)).toBe(VIEWER);
	});

	// Each is the authority's or the holder's PDS saying the holder may not read
	// the space, which a page reads as "not let in".
	it.each([
		['the holder’s session does not read the space', 'delegate', 403, 'ScopeMissingError'],
		['the authority does not let the holder in', 'exchange', 400, 'UserNotAuthorized'],
		['the authority does not let the app in', 'exchange', 400, 'AppNotAuthorized']
	] as const)('throws SpaceAccessDenied when %s', async (_why, step, status, error) => {
		const refusal = () => json(status, { error, message: 'refused' });
		const net = network(step === 'delegate' ? { delegate: refusal } : { exchange: refusal });

		const thrown = await exchangeSpaceCredential(net.holder, MEMBERS, GROUP_HOST).catch((e) => e);

		expect(thrown).toBeInstanceOf(SpaceAccessDenied);
		expect(isSpaceAccessDenied(thrown)).toBe(true);
		expect((thrown as SpaceAccessDenied).space).toBe(MEMBERS);
		expect((thrown as SpaceAccessDenied).reason).toBe(`${status} ${error}`);
		expect(net.exchanges).toHaveLength(step === 'delegate' ? 0 : 1);
	});

	it('throws a plain error, not SpaceAccessDenied, for a refusal that does not name the holder', async () => {
		for (const options of [
			{ delegate: () => json(400, { error: 'InvalidToken' }) },
			{ exchange: () => json(502, { error: 'UpstreamFailure' }) },
			{ exchange: () => json(400, { error: 'SpaceNotFound' }) }
		]) {
			const net = network(options);
			const thrown = await exchangeSpaceCredential(net.holder, MEMBERS, GROUP_HOST).catch((e) => e);
			expect(thrown).toBeInstanceOf(Error);
			expect(isSpaceAccessDenied(thrown)).toBe(false);
		}
	});
});

describe('reading acceptances by DID', () => {
	it('reads each acceptance at that member’s own PDS, signed for that member', async () => {
		const net = network({ accepted: new Set([BOB]) });
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);

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
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);
		const members: GroupMembers = {
			memberships: [BOB, CAROL].map((did) => ({
				uri: `${MEMBERS}/${GROUP_DID}/${GROUP_MEMBERSHIP_COLLECTION}/${did}`,
				rkey: did,
				subject: did,
				roles: ['member'],
				roleIds: ['member'],
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
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);

		expect((await reader.accepted(MEMBERS, [CAROL])).get(CAROL)).toBe(false);
		expect((await reader.accepted(MEMBERS, [CAROL])).get(CAROL)).toBe(false);
		expect(net.exchanges).toHaveLength(1);
	});

	// A host that ignores the collection filter can answer with the member's
	// other record at that key, and that is no acceptance.
	it('reads a record of another collection at the acceptance key as unconfirmed', async () => {
		const net = network({
			answer: (did) =>
				json(200, {
					uri: `${MEMBERS}/${did}/${GROUP_MEMBERSHIP_COLLECTION}/self`,
					cid: 'bafytest',
					value: { $type: GROUP_MEMBERSHIP_COLLECTION }
				})
		});
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);

		expect((await reader.accepted(MEMBERS, [BOB])).get(BOB)).toBe(false);
		expect(net.reads).toHaveLength(1);
	});

	it('reads a member whose DID does not resolve as unconfirmed', async () => {
		const net = network({});
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);
		const answers = await reader.accepted(MEMBERS, ['did:plc:nohostaaaaaaaaaaaaaaaaaa']);
		expect([...answers.values()]).toEqual([false]);
	});

	it('keeps one credential until shortly before it expires, then makes a new key', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(new Date('2026-10-04T10:00:00.000Z'));
		const net = network({ accepted: new Set([BOB]) });
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);

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
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);

		const answers = await reader.accepted(MEMBERS, [BOB]);

		expect(answers.get(BOB)).toBe(true);
		expect(net.exchanges).toHaveLength(2);
		expect(net.reads).toHaveLength(2);
	});

	it('throws when no credential can be had, so the page can show no state', async () => {
		network({});
		const refused: SpaceHolder = {
			did: VIEWER,
			handle: async () => json(400, { error: 'InvalidToken' })
		};
		const reader = credentialAcceptanceReader(refused, GROUP_DID, hosts);
		await expect(reader.accepted(MEMBERS, [BOB])).rejects.toThrow('getDelegationToken');
	});
});

describe('a credential per holder', () => {
	it('two holders reading the same space each get their own credential, and neither is served the other’s', async () => {
		const net = network({ accepted: new Set([BOB]) });
		const carol = credentialAcceptanceReader(net.holderFor(CAROL), GROUP_DID, hosts);
		const mallory = credentialAcceptanceReader(net.holderFor(MALLORY), GROUP_DID, hosts);

		// Interleaved and repeated: each holder's kept credential is theirs alone.
		await carol.accepted(MEMBERS, [BOB]);
		await mallory.accepted(MEMBERS, [BOB]);
		await carol.accepted(MEMBERS, [BOB]);
		await mallory.accepted(MEMBERS, [BOB]);

		// One delegation and one exchange each, from each holder's own session.
		expect(net.exchanges.map((e) => e.headers.get('authorization'))).toEqual([
			`Bearer delegation-${CAROL}-1`,
			`Bearer delegation-${MALLORY}-2`
		]);
		const readers = net.reads.map((read) =>
			holderOf((read.headers.get('authorization') ?? '').replace(/^Atproto-Space /, ''))
		);
		expect(readers).toEqual([CAROL, MALLORY, CAROL, MALLORY]);
	});
});

// A reader is built for one request. Its reads that start together share one
// exchange; nothing still under way is kept past it, because the Workers runtime
// ends a request's I/O with the request, and a later request waiting on that
// exchange would wait forever. (Found by the day-5.2a e2e, 2026-10-15.)
describe('exchanges under way', () => {
	const read = { space: MEMBERS, repo: GROUP_DID, collection: 'x.y.z', rkey: 'self' };
	/** The group's records are at its own host. */
	const groupHosts: SpaceHosts = { ...hosts, repoHost: async () => GROUP_HOST };

	it('reads that start together share one exchange, and a refusal reaches them all without asking again', async () => {
		const net = network({ exchange: () => json(400, { error: 'UserNotAuthorized' }) });
		const reader = credentialSpaceReader(net.holder, groupHosts);
		const reads = [reader.get(read), reader.get(read), reader.list(read)];
		for (const pending of reads) await expect(pending).rejects.toBeInstanceOf(SpaceAccessDenied);
		expect(net.delegations).toHaveLength(1);
		expect(net.exchanges).toHaveLength(1);
	});

	it('an exchange an earlier request left under way is never waited on by the next', async () => {
		const net = network({});
		let abandoned = false;
		const holder: SpaceHolder = {
			did: VIEWER,
			handle: (pathname, init) => {
				if (abandoned) return net.holder.handle(pathname, init);
				abandoned = true;
				// The request that asked for it ended, and its I/O with it.
				return new Promise<Response>(() => {});
			}
		};
		void credentialSpaceReader(holder, groupHosts)
			.get(read)
			.catch(() => {});

		expect(await credentialSpaceReader(holder, groupHosts).get(read)).toBeNull();
		expect(net.exchanges).toHaveLength(1);
	});
});

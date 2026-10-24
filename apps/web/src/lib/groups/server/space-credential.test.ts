// A holder's own space credential, and the acceptance reads made with it.
//
// Five rules are tested here:
//
//   1. The signatures are the alpha's HTTP Message Signatures, byte for byte: the
//      base and the signature-input are @atproto/space's own (the 2026-10-22
//      alpha's createSpaceSigHeaders), and each signature is verified with
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
//   5. A record read asks the repo's host for the record's MAC, and a record whose
//      MAC does not verify is not read.
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
import { fakeKemHost, type FakeKemHost } from './__fixtures__/space-mac-host';
import { recordCid } from './space-mac';

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
/** The KEM key every fake repo publishes; its hosts MAC what they serve with it. */
const kem = await fakeKemHost();
const hosts: SpaceHosts = {
	repoHost: async (did) => HOSTS[did] ?? Promise.reject(new Error(`no host for ${did}`)),
	spaceHost: async () => GROUP_HOST,
	kemKey: async () => kem.did
};

const CREDENTIAL_SIG_INPUT =
	'("authorization" "atproto-space-audience");tag="atproto-space-credential"';

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

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json', ...headers }
	});
}

/** A record read's answer, as `host` serves it: the value's CID and its MAC. With
 *  no host, the same answer with no MAC. */
async function recordResponse(
	host: FakeKemHost | null,
	request: Headers,
	record: { uri: string; value: unknown }
): Promise<Response> {
	const answered = host
		? await host.recordAnswer(request, { ...record, cid: 'bafytest' })
		: { cid: await recordCid(record.value), headers: {} };
	return json(200, { ...record, cid: answered.cid }, answered.headers);
}

async function verifies(signer: SpaceSigningKey, base: string, header: string): Promise<boolean> {
	const match = /^atproto-space-credential=:([A-Za-z0-9+/=]+):$/.exec(header);
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
	it('signs a credential use over the authorization and the audience, as @atproto/space does', async () => {
		const signer = await newSigner();
		const headers = await spaceSigHeaders(signer, 'Atproto-Space-Credential cred.jwt', BOB);

		expect(headers.authorization).toBe('Atproto-Space-Credential cred.jwt');
		expect(headers['atproto-space-audience']).toBe(BOB);
		expect(headers['signature-input']).toBe(`atproto-space-credential=${CREDENTIAL_SIG_INPUT}`);
		const base = [
			'"authorization": Atproto-Space-Credential cred.jwt',
			`"atproto-space-audience": ${BOB}`,
			`"@signature-params": ${CREDENTIAL_SIG_INPUT}`
		].join('\n');
		expect(await verifies(signer, base, headers.signature)).toBe(true);
	});
});

/** A `getSpaceCredential` request's body. */
type ExchangeBody = { space?: unknown; credentialKid?: unknown; delegationToken?: unknown };

/** A fake of every holder's PDS and every member's: a holder's session answers
 *  `getDelegationToken` with a token naming them, the group's host exchanges it
 *  for a credential naming them, and each member's host answers `getRecord`
 *  from `accepted`. */
function network(options: {
	accepted?: Set<string>;
	/** A member host's answer, overriding `accepted`. */
	answer?: (
		did: string,
		credential: string,
		headers: Headers
	) => Response | null | Promise<Response | null>;
	/** The holder's PDS's answer to a delegation request, overriding the token. */
	delegate?: () => Response | null;
	/** The group host's answer to an exchange, overriding the credential. */
	exchange?: () => Response | null;
	lifetimeMs?: number;
}) {
	let issued = 0;
	const delegations: string[] = [];
	const exchanges: { headers: Headers; body: ExchangeBody }[] = [];
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
			const body = JSON.parse(String(init?.body)) as ExchangeBody;
			exchanges.push({ headers, body });
			const refused = options.exchange?.();
			if (refused) return refused;
			issued++;
			const exp = Math.floor((Date.now() + (options.lifetimeMs ?? 600_000)) / 1000);
			const holder = /^delegation-(did:[^-]+)-/.exec(String(body.delegationToken))?.[1];
			return json(200, { credential: jwt({ exp, n: issued, holder }) });
		}
		if (url.pathname === '/xrpc/com.atproto.space.getRecord') {
			reads.push({ url, headers });
			const did = url.searchParams.get('repo') ?? '';
			const credential = (headers.get('authorization') ?? '').replace(
				/^Atproto-Space-Credential /,
				''
			);
			const overridden = await options.answer?.(did, credential, headers);
			if (overridden) return overridden;
			if (options.accepted?.has(did)) {
				return recordResponse(kem, headers, {
					uri: `${MEMBERS}/${did}/${GROUP_ACCEPTANCE_COLLECTION}/self`,
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
	it("gets a delegation token through the holder's own session, then a credential for a new key, both named in the body", async () => {
		const net = network({});
		const cred = await exchangeSpaceCredential(net.holder, MEMBERS, GROUP_HOST);

		expect(net.delegations).toEqual([
			`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space: MEMBERS })}`
		]);
		expect(net.exchanges).toHaveLength(1);
		const [exchange] = net.exchanges;
		expect(cred.signer.keyId).toMatch(/^did:key:zDn/);
		expect(exchange.body).toEqual({
			space: MEMBERS,
			credentialKid: cred.signer.keyId,
			delegationToken: `delegation-${VIEWER}-1`
		});
		// The token is the body's, so the request carries no authorization to sign.
		expect(exchange.headers.get('authorization')).toBeNull();
		expect(exchange.headers.get('signature')).toBeNull();
		expect(cred.expiresAt).toBeGreaterThan(Date.now());
		expect(holderOf(cred.token)).toBe(VIEWER);
	});

	// Each is the authority's or the holder's PDS saying the holder may not read
	// the space, which a page reads as "not let in".
	it.each([
		['the holder’s session does not read the space', 'delegate', 403, 'ScopeMissingError'],
		['the authority does not let the holder in', 'exchange', 400, 'UserNotAuthorized'],
		['the authority does not let the app in', 'exchange', 400, 'AppNotAuthorized'],
		['the authority does not say which it refused', 'exchange', 400, 'NotAuthorized']
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
			expect(read.headers.get('authorization')).toMatch(/^Atproto-Space-Credential /);
			expect(read.headers.get('atproto-space-audience')).toBe(did);
			expect(read.headers.get('signature-input')).toBe(
				`atproto-space-credential=${CREDENTIAL_SIG_INPUT}`
			);
			expect(read.headers.get('atproto-space-want-mac')).toMatch(
				/^type="atproto-space-record", ver=1, key_share="did:key:zDn[1-9A-HJ-NP-Za-km-z]+"$/
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

	// The MAC is the host's proof that the record came from that member's repo: an
	// answer with none, or with one from another key, is no acceptance.
	it('reads an acceptance with no MAC, or a MAC from another key, as unconfirmed', async () => {
		const other = await fakeKemHost();
		const record = {
			uri: `${MEMBERS}/${BOB}/${GROUP_ACCEPTANCE_COLLECTION}/self`,
			value: { $type: GROUP_ACCEPTANCE_COLLECTION, createdAt: '2026-10-04T10:00:00.000Z' }
		};
		for (const mac of [null, other]) {
			clearSpaceCredentials();
			const net = network({
				answer: (_did, _credential, headers) => recordResponse(mac, headers, record)
			});
			const reader = credentialAcceptanceReader(net.holder, GROUP_DID, hosts);
			expect((await reader.accepted(MEMBERS, [BOB])).get(BOB)).toBe(false);
			// Tried once more with the KEM key read anew, then given up.
			expect(net.reads).toHaveLength(2);
		}
	});

	it('reads a member who publishes no KEM key as unconfirmed, without asking their PDS', async () => {
		const net = network({ accepted: new Set([BOB]) });
		const noKem: SpaceHosts = {
			...hosts,
			kemKey: async (did) => Promise.reject(new Error(`${did} names no #atproto_kem key`))
		};
		const reader = credentialAcceptanceReader(net.holder, GROUP_DID, noKem);
		expect((await reader.accepted(MEMBERS, [BOB])).get(BOB)).toBe(false);
		expect(net.reads).toEqual([]);
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
		const keys = net.exchanges.map((e) => e.body.credentialKid);
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
		expect(net.exchanges.map((e) => e.body.delegationToken)).toEqual([
			`delegation-${CAROL}-1`,
			`delegation-${MALLORY}-2`
		]);
		const readers = net.reads.map((read) =>
			holderOf((read.headers.get('authorization') ?? '').replace(/^Atproto-Space-Credential /, ''))
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

// A record is returned only when it is the one asked for, its MAC verifies, and
// its value is what its CID names: the checks the 2026-10-22 alpha's migration
// notes give a reader (alpha-migrations/prompt-10-22-26.md, 4f).
describe('a record read with a credential', () => {
	const read = { space: MEMBERS, repo: GROUP_DID, collection: 'x.y.z', rkey: 'self' };
	const record = { uri: `${MEMBERS}/${GROUP_DID}/x.y.z/self`, value: { n: 1 } };
	const groupHosts: SpaceHosts = { ...hosts, repoHost: async () => GROUP_HOST };
	const readWith = (answer: Parameters<typeof network>[0]['answer'], at = groupHosts) => {
		clearSpaceCredentials();
		const net = network({ answer });
		return { net, pending: credentialSpaceReader(net.holder, at).get(read) };
	};

	it('returns the record when its MAC verifies and its value is its CID’s', async () => {
		const { pending } = readWith((_d, _c, headers) => recordResponse(kem, headers, record));
		expect(await pending).toMatchObject({ uri: record.uri, value: record.value });
	});

	it('never returns a record with no MAC, or with a MAC from another key', async () => {
		const other = await fakeKemHost();
		for (const mac of [null, other]) {
			const { pending } = readWith((_d, _c, headers) => recordResponse(mac, headers, record));
			await expect(pending).rejects.toThrow();
		}
	});

	it('never returns a value its CID does not name, though the MAC verifies', async () => {
		const { pending } = readWith(async (_d, _c, headers) => {
			const answered = await recordResponse(kem, headers, record);
			const body = (await answered.json()) as Record<string, unknown>;
			return json(200, { ...body, value: { n: 2 } }, Object.fromEntries(answered.headers));
		});
		await expect(pending).rejects.toThrow();
	});

	it('never returns another record than the one asked for, though its MAC verifies', async () => {
		const { pending } = readWith((_d, _c, headers) =>
			recordResponse(kem, headers, { ...record, uri: `${MEMBERS}/${GROUP_DID}/x.y.z/other` })
		);
		await expect(pending).rejects.toThrow();
	});

	it('reads the KEM key anew once when the MAC does not verify, as after a rotation', async () => {
		const stale = await fakeKemHost();
		const asked: boolean[] = [];
		const rotated: SpaceHosts = {
			...groupHosts,
			kemKey: async (_did, fresh = false) => {
				asked.push(fresh);
				return fresh ? kem.did : stale.did;
			}
		};
		const { net, pending } = readWith(
			(_d, _c, headers) => recordResponse(kem, headers, record),
			rotated
		);
		expect(await pending).toMatchObject({ uri: record.uri });
		expect(asked).toEqual([false, true]);
		// Each try asks with a key of its own.
		const shares = net.reads.map((r) => r.headers.get('atproto-space-want-mac'));
		expect(shares).toHaveLength(2);
		expect(shares[0]).not.toBe(shares[1]);
	});
});

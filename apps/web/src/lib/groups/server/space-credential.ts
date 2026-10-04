// A space credential for one of a group's spaces, and the reads made with it.
//
// The group's own session (the one seam, ./session.ts) asks the group's PDS for a
// delegation token, and the space authority's host exchanges that token for a
// credential bound to a fresh P-256 key. Every request made with the credential is
// signed with that key over its `authorization` and `atproto-space-audience`
// headers (HTTP Message Signatures, RFC 9421). One credential reads every repo host
// in the space, so each member's acceptance is read at that member's own PDS, by
// their DID. (Spec: FR-207, FR-211.)
//
// A credential lasts 600 s unless the host says otherwise. It is kept per isolate
// until shortly before its `exp`, then replaced with a new key and a new delegation
// token: a credential is never refreshed. An app-password session cannot get a
// delegation token, since the PDS requires a full-access or OAuth session, so only
// a group with a linked session (./linked-session.ts) gets one.
import { P256PrivateKeyExportable, type P256PrivateKey } from '@atcute/crypto';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY } from '../members-record';
import type { GroupRow } from '../types';
import { resolveGroupCredential, type CredentialStoreEnv } from './credentials';
import { groupClient } from './session';
import { splitRecordUri } from './about-read';

const SIGNATURE_LABEL = 'atproto-space';

/** The key a credential is bound to. `keyId` is its P-256 did:key, which the host
 *  writes into the credential as `cnf.kid`. */
export interface SpaceSigningKey {
	key: P256PrivateKey;
	keyId: string;
}

export interface SpaceCredential {
	/** The credential JWT. Never logged. */
	token: string;
	signer: SpaceSigningKey;
	/** Epoch ms of the credential's `exp`, or null when it could not be read, and
	 *  then the credential is not kept. */
	expiresAt: number | null;
}

/** The group's session as the seam hands it out. */
export type GroupHandle = (pathname: string, init: RequestInit) => Promise<Response>;

/** Where a DID's services are. Injectable, because the DID resolvers keep the
 *  `fetch` they were built with. */
export interface SpaceHosts {
	/** The PDS that holds `did`'s repo. */
	repoHost(did: string): Promise<string>;
	/** The host that answers for spaces `did` is the authority of. */
	spaceHost(did: string): Promise<string>;
}

function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	return btoa(out);
}

/**
 * The headers that sign a space request. Without an audience they sign a
 * delegation token for `getSpaceCredential` and name the key, which the host binds
 * the credential to. With one they sign a request made with the credential, and
 * the audience is the repo owner's DID for a repo read, or the authority's DID for
 * a space-host call. The signature base is RFC 9421's: each covered field, then
 * `@signature-params`, joined by LF with no trailing LF.
 */
export async function spaceSigHeaders(
	signer: SpaceSigningKey,
	authorization: string,
	audience?: string
): Promise<Record<string, string>> {
	const params =
		audience === undefined
			? `("authorization");keyid="${signer.keyId}"`
			: '("authorization" "atproto-space-audience")';
	const lines = [`"authorization": ${authorization}`];
	if (audience !== undefined) lines.push(`"atproto-space-audience": ${audience}`);
	lines.push(`"@signature-params": ${params}`);
	// ECDSA P-256 over SHA-256, as 64 bytes r || s, which is what WebCrypto returns.
	const signature = await signer.key.sign(new TextEncoder().encode(lines.join('\n')));
	return {
		authorization,
		...(audience !== undefined ? { 'atproto-space-audience': audience } : {}),
		'signature-input': `${SIGNATURE_LABEL}=${params}`,
		signature: `${SIGNATURE_LABEL}=:${toBase64(signature)}:`
	};
}

/** The `exp` of a JWT, in epoch ms, or null. Read only to know when to replace
 *  the credential: the host checks the signature, so this does not. */
export function credentialExpiry(jwt: string): number | null {
	const payload = jwt.split('.')[1];
	if (!payload) return null;
	try {
		const padded = payload.replace(/-/g, '+').replace(/_/g, '/');
		const json = JSON.parse(atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))) as {
			exp?: unknown;
		};
		return typeof json.exp === 'number' && Number.isFinite(json.exp) ? json.exp * 1000 : null;
	} catch {
		return null;
	}
}

async function errorName(res: Response): Promise<string | null> {
	const body = (await res
		.clone()
		.json()
		.catch(() => null)) as { error?: unknown } | null;
	return typeof body?.error === 'string' ? body.error : null;
}

async function failure(nsid: string, res: Response): Promise<Error> {
	const name = await errorName(res);
	return new Error(`${nsid} failed: ${res.status}${name ? ` ${name}` : ''}`);
}

/** A delegation token from the group's PDS, then a credential for `space` from the
 *  authority's host, bound to a key made for it. Throws on any refusal. */
export async function exchangeSpaceCredential(
	handle: GroupHandle,
	space: string,
	authorityHost: string
): Promise<SpaceCredential> {
	const delegated = await handle(
		`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space })}`,
		{ method: 'GET' }
	);
	if (!delegated.ok) throw await failure('com.atproto.space.getDelegationToken', delegated);
	const { token } = (await delegated.json()) as { token?: unknown };
	if (typeof token !== 'string') {
		throw new Error('com.atproto.space.getDelegationToken returned no token');
	}

	const key = await P256PrivateKeyExportable.createKeypair();
	const signer: SpaceSigningKey = { key, keyId: await key.exportPublicKey('did') };
	const res = await fetch(new URL('/xrpc/com.atproto.space.getSpaceCredential', authorityHost), {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(await spaceSigHeaders(signer, `Bearer ${token}`))
		},
		body: JSON.stringify({ space })
	});
	if (!res.ok) throw await failure('com.atproto.space.getSpaceCredential', res);
	const { credential } = (await res.json()) as { credential?: unknown };
	if (typeof credential !== 'string') {
		throw new Error('com.atproto.space.getSpaceCredential returned no credential');
	}
	return { token: credential, signer, expiresAt: credentialExpiry(credential) };
}

/** How long before its `exp` a kept credential is replaced, for clock skew and the
 *  read's own round trip. */
const EXPIRY_MARGIN_MS = 30_000;

// Keyed by space URI, which names the group. A pending exchange is kept too, so
// reads that start together share one delegation token.
const kept = new Map<string, Promise<SpaceCredential>>();

// Credentials a host called spent. Marked at once, so the retry that follows
// cannot pick the same one back up.
let spent = new WeakSet<SpaceCredential>();

/** A credential for `space`, the kept one while it has time left. */
export async function spaceCredential(
	handle: GroupHandle,
	space: string,
	authorityHost: string
): Promise<SpaceCredential> {
	const pending = kept.get(space);
	if (pending) {
		const held = await pending.catch(() => null);
		if (held?.expiresAt && !spent.has(held) && held.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
			return held;
		}
		if (kept.get(space) === pending) kept.delete(space);
	}
	const exchange = exchangeSpaceCredential(handle, space, authorityHost);
	kept.set(space, exchange);
	try {
		const fresh = await exchange;
		if (!fresh.expiresAt && kept.get(space) === exchange) kept.delete(space);
		return fresh;
	} catch (e) {
		if (kept.get(space) === exchange) kept.delete(space);
		throw e;
	}
}

/** For tests. */
export function clearSpaceCredentials() {
	kept.clear();
	spent = new WeakSet();
	resolved.clear();
}

/** The two refusals that mean the credential itself is spent. Any other refusal
 *  keeps it: a PDS with no spaces support refuses every space call, and that must
 *  not cost the next reader a new credential. */
const SPENT: Record<string, true> = { JwtExpired: true, CredentialRevoked: true };

type AcceptanceRead = 'accepted' | 'absent' | 'spent';

/** One member's acceptance, at their PDS, with the group's credential. A failure
 *  other than a spent credential reads as absent and is logged: the roster then
 *  shows the member unconfirmed, which is also what FR-204 asks for a member whose
 *  PDS serves no spaces. */
async function readAcceptance(
	cred: SpaceCredential,
	hosts: SpaceHosts,
	space: string,
	did: string
): Promise<AcceptanceRead> {
	try {
		const host = await hosts.repoHost(did);
		const query = new URLSearchParams({
			space,
			repo: did,
			collection: GROUP_ACCEPTANCE_COLLECTION,
			rkey: GROUP_ACCEPTANCE_RKEY
		});
		const res = await fetch(new URL(`/xrpc/com.atproto.space.getRecord?${query}`, host), {
			method: 'GET',
			headers: await spaceSigHeaders(cred.signer, `Atproto-Space ${cred.token}`, did)
		});
		if (res.ok) {
			const body = (await res.json().catch(() => null)) as { uri?: unknown } | null;
			// Checked, as the other readers do, in case a host ignores the collection.
			const uri = typeof body?.uri === 'string' ? body.uri : '';
			return splitRecordUri(uri).collection === GROUP_ACCEPTANCE_COLLECTION ? 'accepted' : 'absent';
		}
		const name = await errorName(res);
		if (res.status === 400 && name === 'RecordNotFound') return 'absent';
		if (name && SPENT[name]) return 'spent';
		console.info(
			`[groups] acceptance read for ${did} in ${space}: ${res.status}${name ? ` ${name}` : ''}`
		);
		return 'absent';
	} catch (e) {
		console.info(`[groups] acceptance read for ${did} in ${space} failed:`, e);
		return 'absent';
	}
}

/** Reads whether each member wrote their acceptance. */
export interface AcceptanceReader {
	/** Whether each DID has an acceptance in `space`. Only the DIDs passed in are
	 *  read, so an acceptance from someone with no membership never reaches the
	 *  roster. Throws only when no credential can be had. */
	accepted(space: string, dids: readonly string[]): Promise<Map<string, boolean>>;
}

/** The reader over one group's session. A credential the hosts call spent is
 *  replaced once, and those DIDs read again. */
export function credentialAcceptanceReader(
	handle: GroupHandle,
	authorityDid: string,
	hosts: SpaceHosts
): AcceptanceReader {
	return {
		async accepted(space, dids) {
			const authorityHost = await hosts.spaceHost(authorityDid);
			const answers = new Map<string, boolean>();
			let pending = [...new Set(dids)];
			for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
				const cred = await spaceCredential(handle, space, authorityHost);
				const reads = await Promise.all(
					pending.map(async (did) => [did, await readAcceptance(cred, hosts, space, did)] as const)
				);
				pending = [];
				for (const [did, read] of reads) {
					if (read === 'spent') pending.push(did);
					else answers.set(did, read === 'accepted');
				}
				if (pending.length > 0) spent.add(cred);
			}
			for (const did of pending) answers.set(did, false);
			return answers;
		}
	};
}

const didResolver = new CompositeDidDocumentResolver({
	methods: { plc: new PlcDidDocumentResolver(), web: new WebDidDocumentResolver() }
});

/** How long a resolved endpoint is kept. A roster page reads one per member. */
const RESOLVED_TTL_MS = 10 * 60 * 1000;
const resolved = new Map<string, { endpoint: string; at: number }>();

/** The endpoint of the first of `ids` the DID document names. */
async function serviceEndpoint(did: string, ids: readonly `#${string}`[]): Promise<string> {
	const cacheKey = `${did}|${ids.join(',')}`;
	const hit = resolved.get(cacheKey);
	if (hit && Date.now() - hit.at < RESOLVED_TTL_MS) return hit.endpoint;

	const doc = await didResolver.resolve(did as Did<'plc'> | Did<'web'>);
	for (const id of ids) {
		const service = doc.service?.find((s) => s.id === id || s.id === `${doc.id}${id}`);
		if (service && typeof service.serviceEndpoint === 'string') {
			resolved.set(cacheKey, { endpoint: service.serviceEndpoint, at: Date.now() });
			return service.serviceEndpoint;
		}
	}
	throw new Error(`${did} names no ${ids.join(' or ')} service`);
}

/** Hosts from DID documents. A space authority may name a separate space host,
 *  and its PDS answers when it does not. */
export const didSpaceHosts: SpaceHosts = {
	repoHost: (did) => serviceEndpoint(did, ['#atproto_pds']),
	spaceHost: (did) => serviceEndpoint(did, ['#atproto_space_host', '#atproto_pds'])
};

/** The acceptance reader for a group, or null when this deployment holds no
 *  linked session for it. An app password cannot get a delegation token, so a
 *  group still on one has no reader rather than one that always fails. */
export async function groupAcceptanceReader(
	env: CredentialStoreEnv,
	db: D1Database,
	group: Pick<GroupRow, 'group_did'>,
	hosts: SpaceHosts = didSpaceHosts
): Promise<AcceptanceReader | null> {
	const cred = await resolveGroupCredential(env, db, group.group_did);
	if (cred?.kind !== 'linked') return null;
	const { handle } = await groupClient(cred, group.group_did);
	return credentialAcceptanceReader(handle, group.group_did, hosts);
}

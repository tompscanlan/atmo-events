// A space credential and the reads made with it: a delegation token from the holder's
// PDS, exchanged at the authority's host for a credential bound to a fresh P-256 key,
// which signs every request (RFC 9421). A record read also checks the MAC (./space-mac.ts).
import { P256PrivateKeyExportable, type P256PrivateKey } from '@atcute/crypto';
import type { Did } from '@atcute/lexicons';
import { createDidDocumentResolver } from '$lib/atproto/identity';
import { spaceRecordUri } from '../ids';
import { describeFailure, readXrpc, xrpcError, type XrpcAnswer, type XrpcHandle } from './xrpc';
import { MAC_HEADER, recordCid, recordMacCheck, WANT_MAC_HEADER } from './space-mac';

const SIGNATURE_LABEL = 'atproto-space-credential';
const AUTH_SCHEME = 'Atproto-Space-Credential';
const GET_RECORD = 'com.atproto.space.getRecord';

export interface SpaceSigningKey {
	key: P256PrivateKey;
	keyId: string;
}

export interface SpaceCredential {
	/** Never logged. */
	token: string;
	signer: SpaceSigningKey;
	/** Null when it could not be read, and then the credential is not kept. */
	expiresAt: number | null;
}

export interface SpaceHolder {
	did: string;
	handle: XrpcHandle;
}

/** An answer, not an outage: the holder may not read the space. */
export class SpaceAccessDenied extends Error {
	constructor(
		readonly space: string,
		readonly reason: string
	) {
		super(`not let into ${space}: ${reason}`);
		this.name = 'SpaceAccessDenied';
	}
}

export function isSpaceAccessDenied(e: unknown): e is SpaceAccessDenied {
	return e instanceof SpaceAccessDenied;
}

const DENIED: Record<string, true> = {
	ScopeMissingError: true,
	UserNotAuthorized: true,
	AppNotAuthorized: true,
	NotAuthorized: true
};

export interface SpaceHosts {
	repoHost(did: string): Promise<string>;
	/** `fresh` after a MAC that did not verify, since the key may have rotated. */
	kemKey(did: string, fresh?: boolean): Promise<string>;
}

function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	return btoa(out);
}

export async function spaceSigHeaders(
	signer: SpaceSigningKey,
	authorization: string,
	audience: string
): Promise<Record<string, string>> {
	const params = `("authorization" "atproto-space-audience");tag="${SIGNATURE_LABEL}"`;
	const lines = [
		`"authorization": ${authorization}`,
		`"atproto-space-audience": ${audience}`,
		`"@signature-params": ${params}`
	];
	const signature = await signer.key.sign(new TextEncoder().encode(lines.join('\n')));
	return {
		authorization,
		'atproto-space-audience': audience,
		'signature-input': `${SIGNATURE_LABEL}=${params}`,
		signature: `${SIGNATURE_LABEL}=:${toBase64(signature)}:`
	};
}

/** Read only to know when to replace the credential: the host checks the signature. */
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


export async function exchangeSpaceCredential(
	holder: SpaceHolder,
	space: string,
	authorityHost: string
): Promise<SpaceCredential> {
	const delegated = await holder.handle(
		`/xrpc/com.atproto.space.getDelegationToken?${new URLSearchParams({ space })}`,
		{ method: 'GET' }
	);
	const delegation = await readXrpc(delegated);
	if (!delegation.ok) {
		if (delegation.error && DENIED[delegation.error]) {
			throw new SpaceAccessDenied(space, describeFailure(delegation));
		}
		throw xrpcError('com.atproto.space.getDelegationToken', delegation);
	}
	const { token } = delegation.data;
	if (typeof token !== 'string') {
		throw new Error('com.atproto.space.getDelegationToken returned no token');
	}

	const key = await P256PrivateKeyExportable.createKeypair();
	const signer: SpaceSigningKey = { key, keyId: await key.exportPublicKey('did') };
	const res = await fetch(new URL('/xrpc/com.atproto.space.getSpaceCredential', authorityHost), {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ space, credentialKid: signer.keyId, delegationToken: token })
	});
	const issued = await readXrpc(res);
	if (!issued.ok) {
		if (issued.error && DENIED[issued.error]) {
			throw new SpaceAccessDenied(space, describeFailure(issued));
		}
		throw xrpcError('com.atproto.space.getSpaceCredential', issued);
	}
	const { credential } = issued.data;
	if (typeof credential !== 'string') {
		throw new Error('com.atproto.space.getSpaceCredential returned no credential');
	}
	return { token: credential, signer, expiresAt: credentialExpiry(credential) };
}

const EXPIRY_MARGIN_MS = 30_000;
const MAX_KEPT = 500;

// Keyed by holder and space. Only an issued credential is kept, never an exchange
// still under way: Workers ends a request's I/O with the request, so an exchange kept
// past it may never settle, and the next request to wait on it would wait forever.
const kept = new Map<string, SpaceCredential>();

let spent = new WeakSet<SpaceCredential>();

/** Reads in one request that start together share one exchange. */
export type ExchangesUnderWay = Map<string, Promise<SpaceCredential>>;

export async function spaceCredential(
	holder: SpaceHolder,
	space: string,
	authorityHost: string,
	underWay?: ExchangesUnderWay
): Promise<SpaceCredential> {
	const key = `${holder.did} ${space}`;
	const held = kept.get(key);
	if (held?.expiresAt && !spent.has(held) && held.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
		return held;
	}
	if (held) kept.delete(key);
	const shared = underWay?.get(key);
	if (shared) return shared;
	const exchange = exchangeSpaceCredential(holder, space, authorityHost).then((fresh) => {
		if (fresh.expiresAt) {
			if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value!);
			kept.set(key, fresh);
		}
		return fresh;
	});
	underWay?.set(key, exchange);
	try {
		return await exchange;
	} finally {
		if (underWay?.get(key) === exchange) underWay.delete(key);
	}
}

export function clearSpaceCredentials() {
	kept.clear();
	spent = new WeakSet();
	resolved.clear();
}

// Only these mean the credential itself is spent: a PDS with no spaces support refuses
// every space call, and that must not cost the next reader a new credential.
const SPENT: Record<string, true> = { JwtExpired: true, CredentialRevoked: true };

export function spaceAuthority(space: string): string {
	const did = space.startsWith('at://') ? space.slice('at://'.length).split('/')[0] : '';
	if (!did.startsWith('did:')) throw new Error(`not a space URI: ${space}`);
	return did;
}


type SpaceCall = { host: string; audience: string; nsid: string; query: Record<string, string> };

/** A record comes back only when it is the one asked for and its MAC and CID check. */
async function fetchWithCredential(
	cred: SpaceCredential,
	hosts: SpaceHosts,
	call: SpaceCall
): Promise<Response> {
	const url = new URL(`/xrpc/${call.nsid}?${new URLSearchParams(call.query)}`, call.host);
	const headers = await spaceSigHeaders(cred.signer, `${AUTH_SCHEME} ${cred.token}`, call.audience);
	if (call.nsid !== GET_RECORD) return fetch(url, { method: 'GET', headers });

	const { space, repo, collection, rkey } = call.query;
	const uri = spaceRecordUri(space, repo, collection, rkey);
	for (let attempt = 0; ; attempt++) {
		const mac = await recordMacCheck(await hosts.kemKey(repo, attempt > 0));
		const res = await fetch(url, {
			method: 'GET',
			headers: { ...headers, [WANT_MAC_HEADER]: mac.header }
		});
		if (!res.ok) return res;
		const body = (await res.clone().json()) as { uri?: unknown; cid?: unknown; value?: unknown };
		if (body.uri !== uri) {
			throw new Error(`${GET_RECORD} at ${call.host} answered ${String(body.uri)} for ${uri}`);
		}
		const cid = String(body.cid ?? '');
		if (await mac.verify({ uri, cid }, res.headers.get(MAC_HEADER))) {
			if ((await recordCid(body.value).catch(() => null)) !== cid) {
				throw new Error(`${GET_RECORD} at ${call.host}: the value of ${uri} is not its CID's`);
			}
			return res;
		}
		if (attempt > 0) {
			throw new Error(`${GET_RECORD} at ${call.host}: the MAC of ${uri} does not verify`);
		}
	}
}

/** A credential the host calls spent is replaced once. */
export async function credentialRequest(
	holder: SpaceHolder,
	hosts: SpaceHosts,
	space: string,
	call: SpaceCall,
	underWay?: ExchangesUnderWay
): Promise<XrpcAnswer> {
	const authorityHost = await hosts.repoHost(spaceAuthority(space));
	for (let attempt = 0; ; attempt++) {
		const cred = await spaceCredential(holder, space, authorityHost, underWay);
		const answer = await readXrpc(await fetchWithCredential(cred, hosts, call));
		if (answer.ok || attempt > 0 || !answer.error || !SPENT[answer.error]) return answer;
		spent.add(cred);
	}
}

const RESOLVED_TTL_MS = 10 * 60 * 1000;
const resolved = new Map<string, { value: string; at: number }>();

async function serviceEndpoint(did: string, ids: readonly `#${string}`[]): Promise<string> {
	const cacheKey = `${did}|${ids.join(',')}`;
	const hit = resolved.get(cacheKey);
	if (hit && Date.now() - hit.at < RESOLVED_TTL_MS) return hit.value;

	const doc = await createDidDocumentResolver().resolve(did as Did<'plc'> | Did<'web'>);
	for (const id of ids) {
		const service = doc.service?.find((s) => s.id === id || s.id === `${doc.id}${id}`);
		if (service && typeof service.serviceEndpoint === 'string') {
			resolved.set(cacheKey, { value: service.serviceEndpoint, at: Date.now() });
			return service.serviceEndpoint;
		}
	}
	throw new Error(`${did} names no ${ids.join(' or ')} service`);
}

async function kemKey(did: string, fresh = false): Promise<string> {
	const cacheKey = `${did}|#atproto_kem`;
	const hit = resolved.get(cacheKey);
	if (!fresh && hit && Date.now() - hit.at < RESOLVED_TTL_MS) return hit.value;

	const doc = await createDidDocumentResolver().resolve(did as Did<'plc'> | Did<'web'>);
	const method = doc.verificationMethod?.find(
		(m) => m.id === '#atproto_kem' || m.id === `${doc.id}#atproto_kem`
	);
	const multibase = method && 'publicKeyMultibase' in method ? method.publicKeyMultibase : null;
	if (typeof multibase !== 'string') throw new Error(`${did} names no #atproto_kem key`);
	const key = `did:key:${multibase}`;
	resolved.set(cacheKey, { value: key, at: Date.now() });
	return key;
}

export const didSpaceHosts: SpaceHosts = {
	repoHost: (did) => serviceEndpoint(did, ['#atproto_pds']),
	kemKey
};

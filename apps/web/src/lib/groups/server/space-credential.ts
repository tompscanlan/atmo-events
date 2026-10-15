// A space credential for one of a group's spaces, and the reads made with it.
//
// A holder's own session (./acceptance.ts `MemberSession`, or the group's own,
// ./session.ts) asks its PDS for a delegation token, and the space authority's
// host exchanges that token for a credential bound to a fresh P-256 key. Every
// request made with the credential is signed with that key over its
// `authorization` and `atproto-space-audience` headers (HTTP Message Signatures,
// RFC 9421). One credential reads every repo host in the space, so each member's
// acceptance is read at that member's own PDS, by their DID. (Spec: FR-207,
// FR-211.)
//
// Each person reads with their own credential, so no one's session reads for
// anyone else (TS 2026-10-15). The authority decides who gets one: a refusal is
// `SpaceAccessDenied`, which a page reads as "not let in", never as "unreachable".
//
// A credential lasts 600 s unless the host says otherwise. Once issued, it is kept
// per isolate, per holder and space, until shortly before its `exp`, then
// replaced with a new key and a new delegation token: a credential is never
// refreshed. The PDS issues
// a delegation token only to a full-access or OAuth session, and an OAuth session
// only when its scope reads the space.
import { P256PrivateKeyExportable, type P256PrivateKey } from '@atcute/crypto';
import {
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver
} from '@atcute/identity-resolver';
import type { Did } from '@atcute/lexicons';
import { GROUP_ACCEPTANCE_COLLECTION, GROUP_ACCEPTANCE_RKEY } from '../members-record';
import { splitRecordUri } from '../ids';
import {
	describeFailure,
	isRecordNotFound,
	readXrpc,
	xrpcError,
	type XrpcAnswer,
	type XrpcHandle
} from './xrpc';
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

/** Whose session asks for a credential, and the session's request function. */
export interface SpaceHolder {
	did: string;
	handle: XrpcHandle;
}

/** The space's authority refused the holder a credential: the holder's session
 *  does not read the space (`ScopeMissingError`), or the authority does not let
 *  the holder or the app in (`UserNotAuthorized`, `AppNotAuthorized`). It is an
 *  answer, not an outage: the holder may not read the space. */
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

/** The refusals that say the holder may not read the space. */
const DENIED: Record<string, true> = {
	ScopeMissingError: true,
	UserNotAuthorized: true,
	AppNotAuthorized: true
};

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

/** A delegation token from the holder's PDS, then a credential for `space` from
 *  the authority's host, bound to a key made for it. A refusal that names the
 *  holder throws `SpaceAccessDenied`; any other throws as it is. */
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
		headers: {
			'content-type': 'application/json',
			...(await spaceSigHeaders(signer, `Bearer ${token}`))
		},
		body: JSON.stringify({ space })
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

/** How long before its `exp` a kept credential is replaced, for clock skew and the
 *  read's own round trip. */
const EXPIRY_MARGIN_MS = 30_000;

// Keyed by holder and space URI, so no holder is ever served another's
// credential. Only a credential already issued is kept, never an exchange still
// under way: the Workers runtime ends a request's I/O with the request, so an
// exchange kept past the request that started it may never settle, and the next
// request to wait on it would wait forever.
const kept = new Map<string, SpaceCredential>();

// Credentials a host called spent. Marked at once, so the retry that follows
// cannot pick the same one back up.
let spent = new WeakSet<SpaceCredential>();

/** Exchanges under way, for one request's reads: reads that start together
 *  share one delegation token. Made per request (`credentialSpaceReader`) and
 *  never kept past it. */
export type ExchangesUnderWay = Map<string, Promise<SpaceCredential>>;

/** A credential for `space`, the holder's kept one while it has time left, else
 *  the exchange `underWay` holds for it, else a new one. A refusal reaches every
 *  read that shared the exchange, and none of them asks again. */
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
		if (fresh.expiresAt) kept.set(key, fresh);
		return fresh;
	});
	underWay?.set(key, exchange);
	try {
		return await exchange;
	} finally {
		if (underWay?.get(key) === exchange) underWay.delete(key);
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

/** The DID a space URI names, `at://<authority>/space/<type>/<skey>`. */
export function spaceAuthority(space: string): string {
	const did = space.startsWith('at://') ? space.slice('at://'.length).split('/')[0] : '';
	if (!did.startsWith('did:')) throw new Error(`not a space URI: ${space}`);
	return did;
}

/** One request made with the holder's credential for `space`: a GET at `host`,
 *  signed for `audience` (the repo owner's DID for a repo read, the authority's
 *  for a space-host call). A credential the host calls spent is replaced once.
 *  Throws `SpaceAccessDenied` when the authority issues none. */
export async function credentialRequest(
	holder: SpaceHolder,
	hosts: SpaceHosts,
	space: string,
	call: { host: string; audience: string; nsid: string; query: Record<string, string> },
	underWay?: ExchangesUnderWay
): Promise<XrpcAnswer> {
	const authorityHost = await hosts.spaceHost(spaceAuthority(space));
	const url = new URL(`/xrpc/${call.nsid}?${new URLSearchParams(call.query)}`, call.host);
	for (let attempt = 0; ; attempt++) {
		const cred = await spaceCredential(holder, space, authorityHost, underWay);
		const res = await fetch(url, {
			method: 'GET',
			headers: await spaceSigHeaders(cred.signer, `Atproto-Space ${cred.token}`, call.audience)
		});
		const answer = await readXrpc(res);
		if (answer.ok || attempt > 0 || !answer.error || !SPENT[answer.error]) return answer;
		spent.add(cred);
	}
}

/** One member's acceptance, at their PDS, with the reader's credential. A failure
 *  other than a spent credential reads as absent and is logged: the roster then
 *  shows the member unconfirmed, which is also how it shows a member whose PDS
 *  serves no spaces. (Spec: FR-204.) */
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
		const answer = await readXrpc(res);
		if (answer.ok) {
			// Checked, as the other readers do, in case a host ignores the collection.
			const uri = typeof answer.data.uri === 'string' ? answer.data.uri : '';
			return splitRecordUri(uri).collection === GROUP_ACCEPTANCE_COLLECTION ? 'accepted' : 'absent';
		}
		if (isRecordNotFound(answer)) return 'absent';
		if (answer.error && SPENT[answer.error]) return 'spent';
		console.info(`[groups] acceptance read for ${did} in ${space}: ${describeFailure(answer)}`);
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

/** The reader over the holder's own session. A credential the hosts call spent
 *  is replaced once, and those DIDs read again. */
export function credentialAcceptanceReader(
	holder: SpaceHolder,
	authorityDid: string,
	hosts: SpaceHosts = didSpaceHosts
): AcceptanceReader {
	return {
		async accepted(space, dids) {
			const authorityHost = await hosts.spaceHost(authorityDid);
			const answers = new Map<string, boolean>();
			let pending = [...new Set(dids)];
			for (let attempt = 0; attempt < 2 && pending.length > 0; attempt++) {
				const cred = await spaceCredential(holder, space, authorityHost);
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

// Each resolver calls the global `fetch` when it resolves, not the one there was
// when it was built, so a test's stubbed `fetch` answers it.
const liveFetch: typeof fetch = (input, init) => fetch(input, init);
const didResolver = new CompositeDidDocumentResolver({
	methods: {
		plc: new PlcDidDocumentResolver({ fetch: liveFetch }),
		web: new WebDidDocumentResolver({ fetch: liveFetch })
	}
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

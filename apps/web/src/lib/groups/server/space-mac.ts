// The MAC a repo host puts on a space record read with a credential.
//
// A space repo authenticates what it serves with a MAC, not a signature, so a
// leaked response proves nothing to anyone else. A record read made with a
// credential must ask for one: `atproto-space-want-mac` names a P-256 key made
// for that one request, the repo's host derives a secret shared with it from the
// repo's own `#atproto_kem` key, and it answers with `atproto-space-mac`, an HMAC
// of the record's URI and CID under that secret. A host refuses a credential read
// that asks for none (`BadSpaceMac`). The MAC vouches for the URI and the CID the
// host names, so a reader also checks the value against that CID (`recordCid`).
//
// The secret is ECDH on P-256 put through DHKEM(P-256, HKDF-SHA256), RFC 9180
// § 4.1, as @atproto/space derives it (kem.ts, mac.ts, on the 2026-10-22 alpha).
// The cryptography is WebCrypto, which the Workers runtime has.
import { encode } from '@atcute/cbor';
import { CODEC_DCBOR, create, fromString, toString } from '@atcute/cid';
import { P256PublicKey, parseDidKey } from '@atcute/crypto';

export const WANT_MAC_HEADER = 'atproto-space-want-mac';
export const MAC_HEADER = 'atproto-space-mac';
const RECORD_MAC_TYPE = 'atproto-space-record';
const RECORD_MAC_VERSION = 1;

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

const utf8 = (text: string) => new TextEncoder().encode(text);
const uint16be = (n: number) => Uint8Array.of(n >> 8, n & 0xff);

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

function lengthPrefixed(text: string): Uint8Array {
	const bytes = utf8(text);
	return concat([uint16be(bytes.length), bytes]);
}

// RFC 9180's labels. 0x0010 names DHKEM(P-256, HKDF-SHA256).
const KEM_PREFIX = concat([utf8('HPKE-v1'), utf8('KEM'), uint16be(0x0010)]);

/** A P-256 did:key as an ECDH public key, with its uncompressed point, which the
 *  secret is derived over. */
export async function ecdhPublicKey(
	didKey: string
): Promise<{ key: CryptoKey; point: Uint8Array }> {
	const found = parseDidKey(didKey);
	if (found.type !== 'p256') throw new Error(`not a P-256 key: ${didKey}`);
	const { x, y } = await (
		await P256PublicKey.importRaw(found.publicKeyBytes)
	).exportPublicKey('jwk');
	const key = await crypto.subtle.importKey(
		'jwk',
		{ kty: 'EC', crv: 'P-256', x, y },
		ECDH,
		true,
		[]
	);
	return { key, point: new Uint8Array(await crypto.subtle.exportKey('raw', key)) };
}

/** The secret both sides derive from one ECDH result: `reader` is the point of the
 *  key made for the request, `repo` the point of the repo's `#atproto_kem` key. */
export async function sharedSecret(
	dh: Uint8Array,
	reader: Uint8Array,
	repo: Uint8Array
): Promise<Uint8Array<ArrayBuffer>> {
	const ikm = concat([KEM_PREFIX, utf8('eae_prk'), dh]);
	const info = concat([uint16be(32), KEM_PREFIX, utf8('shared_secret'), reader, repo]);
	const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info },
		key,
		256
	);
	return new Uint8Array(bits);
}

/** The CID of a record's value: of its DRISL encoding (deterministic CBOR, with
 *  `$link` and `$bytes` as their CBOR forms). A MAC vouches for the CID a host
 *  names, so a reader checks the value against it too. */
export async function recordCid(value: unknown): Promise<string> {
	return toString(await create(CODEC_DCBOR, encode(value)));
}

/** HMAC-SHA256 over `atproto-space-record-v1`, the URI with its length, and the
 *  CID's bytes. */
export async function recordMac(secret: Uint8Array<ArrayBuffer>, uri: string, cid: string) {
	const key = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const data = concat([
		utf8(`${RECORD_MAC_TYPE}-v${RECORD_MAC_VERSION}`),
		lengthPrefixed(uri),
		fromString(cid).bytes
	]);
	return new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
}

/** The MAC in an `atproto-space-mac` header, or null when there is none for a
 *  record at this version. */
function macFromHeader(value: string | null): Uint8Array | null {
	if (!value) return null;
	const fields = new Map(
		value.split(',').map((member) => {
			const eq = member.indexOf('=');
			return [member.slice(0, eq).trim(), member.slice(eq + 1).trim()] as const;
		})
	);
	if (fields.get('type') !== `"${RECORD_MAC_TYPE}"`) return null;
	if (fields.get('ver') !== String(RECORD_MAC_VERSION)) return null;
	const mac = /^:([A-Za-z0-9+/]*={0,2}):$/.exec(fields.get('mac') ?? '');
	return mac ? Uint8Array.from(atob(mac[1]), (c) => c.charCodeAt(0)) : null;
}

/** One record read's MAC: the header that asks for it, and the check of the
 *  answer. Made per request, since each takes a key of its own. */
export interface RecordMacCheck {
	header: string;
	/** Whether the answer's `atproto-space-mac` is the MAC of this URI and CID. */
	verify(record: { uri: string; cid: string }, macHeader: string | null): Promise<boolean>;
}

/** A MAC request against the repo's `#atproto_kem` key, a P-256 did:key. Tests pass
 *  `ephemeral` to fix the request's key. */
export async function recordMacCheck(
	repoKemKey: string,
	ephemeral?: CryptoKeyPair
): Promise<RecordMacCheck> {
	const repo = await ecdhPublicKey(repoKemKey);
	const pair =
		ephemeral ?? ((await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair);
	const reader = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const keyShare = await (await P256PublicKey.importRaw(reader)).exportPublicKey('did');
	const dh = await crypto.subtle.deriveBits(
		{ name: 'ECDH', public: repo.key },
		pair.privateKey,
		256
	);
	const secret = await sharedSecret(new Uint8Array(dh), reader, repo.point);
	return {
		header: `type="${RECORD_MAC_TYPE}", ver=${RECORD_MAC_VERSION}, key_share="${keyShare}"`,
		async verify({ uri, cid }, macHeader) {
			const got = macFromHeader(macHeader);
			// A CID that does not parse cannot be the record's, so nothing matches it.
			const want = got && (await recordMac(secret, uri, cid).catch(() => null));
			if (!got || !want) return false;
			let diff = got.length ^ want.length;
			for (let i = 0; i < want.length; i++) diff |= want[i] ^ (got[i] ?? 0);
			return diff === 0;
		}
	};
}

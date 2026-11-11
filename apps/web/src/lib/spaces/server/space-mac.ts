// The MAC a repo host puts on a space record read with a credential: the reader sends a
// one-off P-256 key in `atproto-space-want-mac`, and the host answers with an HMAC of the
// record's URI and CID under a secret both derive from that key and the repo's
// `#atproto_kem` key. @atproto/space does the key exchange, the MAC and both headers. The
// reader also checks the value against that CID.
import { encode } from '@atcute/cbor';
import { CODEC_DCBOR, create, toString } from '@atcute/cid';
import { parseCidSafe } from '@atproto/lex-data';
import {
	encapsulate,
	formatWantMacHeader,
	parseMacHeader,
	RECORD_MAC_TYPE,
	verifyRecordMac
} from '@atproto/space';

export { MAC_HEADER, WANT_MAC_HEADER } from '@atproto/space';

/** The CID of a record's DRISL encoding. `getRecord` answers in JSON, and @atcute/cbor reads
 *  its `$link` and `$bytes` as a link and bytes, as the repo host did. */
export async function recordCid(value: unknown): Promise<string> {
	return toString(await create(CODEC_DCBOR, encode(value)));
}

function macFromHeader(value: string | null): Uint8Array | null {
	try {
		return parseMacHeader(value ?? undefined, RECORD_MAC_TYPE);
	} catch {
		// None, malformed, or for a commit or another version.
		return null;
	}
}

/** Made per request, since each takes a key of its own. */
export interface RecordMacCheck {
	header: string;
	verify(record: { uri: string; cid: string }, macHeader: string | null): boolean;
}

export async function recordMacCheck(repoKemKey: string): Promise<RecordMacCheck> {
	const { keyShare, sharedSecret } = await encapsulate(repoKemKey);
	return {
		header: formatWantMacHeader(RECORD_MAC_TYPE, keyShare),
		verify({ uri, cid }, macHeader) {
			const mac = macFromHeader(macHeader);
			// A CID that does not parse cannot be the record's, so nothing matches it.
			const parsed = parseCidSafe(cid);
			return !!mac && !!parsed && verifyRecordMac(sharedSecret, uri, parsed, mac);
		}
	};
}

// A repo host's side of the record MAC (../space-mac.ts), for fakes: one KEM key that
// every fake repo publishes as `#atproto_kem`, and a record read's answer as a host gives
// it, computed by @atproto/space as on a real host. The reader's side is checked against
// fixed values in ../space-mac.test.ts.
import { P256Keypair } from '@atproto/crypto';
import { parseCid } from '@atproto/lex-data';
import {
	computeRecordMac,
	decapsulate,
	formatMacHeader,
	parseWantMacHeader,
	RECORD_MAC_TYPE
} from '@atproto/space';

import { MAC_HEADER, recordCid, WANT_MAC_HEADER } from '../space-mac';

export interface FakeKemHost {
	/** The key as a did:key, what `SpaceHosts.kemKey` resolves to. */
	did: string;
	/** The key as a DID document's `publicKeyMultibase`. */
	multibase: string;
	/** A record read's CID and headers. A read that asks for a MAC gets what a
	 *  host serves it: the value's real CID and the MAC over it. Any other keeps
	 *  the fake's CID and gets no MAC. */
	recordAnswer(
		request: Headers,
		record: { uri: string; cid: string; value: unknown }
	): Promise<{ cid: string; headers: Record<string, string> }>;
}

function keyShareOf(request: Headers): string | null {
	try {
		return parseWantMacHeader(request.get(WANT_MAC_HEADER) ?? undefined, RECORD_MAC_TYPE);
	} catch {
		return null;
	}
}

export async function fakeKemHost(): Promise<FakeKemHost> {
	const pair = await P256Keypair.create();
	const did = pair.did();
	return {
		did,
		multibase: did.slice('did:key:'.length),
		async recordAnswer(request, { uri, cid, value }): ReturnType<FakeKemHost['recordAnswer']> {
			const keyShare = keyShareOf(request);
			if (!keyShare) return { cid, headers: {} };
			const real = await recordCid(value);
			const mac = computeRecordMac(decapsulate(pair, keyShare), uri, parseCid(real));
			return { cid: real, headers: { [MAC_HEADER]: formatMacHeader(RECORD_MAC_TYPE, mac) } };
		}
	};
}

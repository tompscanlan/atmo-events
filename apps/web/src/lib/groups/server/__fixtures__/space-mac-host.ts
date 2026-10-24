// A repo host's side of the record MAC (../space-mac.ts), for fakes: one KEM key
// that every fake repo publishes as `#atproto_kem`, and the `atproto-space-mac`
// answer to a read's `atproto-space-want-mac`. The derivation itself is checked
// against @atproto/space in ../space-mac.test.ts.
import { P256PublicKey } from '@atcute/crypto';

import { ecdhPublicKey, MAC_HEADER, recordMac, sharedSecret, WANT_MAC_HEADER } from '../space-mac';

const ECDH = { name: 'ECDH', namedCurve: 'P-256' } as const;

export interface FakeKemHost {
	/** The key as a did:key, what `SpaceHosts.kemKey` resolves to. */
	did: string;
	/** The key as a DID document's `publicKeyMultibase`. */
	multibase: string;
	/** The MAC header for this record, or no header when the read asked for none. */
	macHeaders(
		request: Headers,
		record: { uri: string; cid: string }
	): Promise<Record<string, string>>;
}

export async function fakeKemHost(): Promise<FakeKemHost> {
	const pair = (await crypto.subtle.generateKey(ECDH, true, ['deriveBits'])) as CryptoKeyPair;
	const point = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
	const did = await (await P256PublicKey.importRaw(point)).exportPublicKey('did');
	return {
		did,
		multibase: did.slice('did:key:'.length),
		async macHeaders(request, { uri, cid }): Promise<Record<string, string>> {
			const keyShare = /key_share="([^"]+)"/.exec(request.get(WANT_MAC_HEADER) ?? '')?.[1];
			if (!keyShare) return {};
			const reader = await ecdhPublicKey(keyShare);
			const dh = await crypto.subtle.deriveBits(
				{ name: 'ECDH', public: reader.key },
				pair.privateKey,
				256
			);
			const secret = await sharedSecret(new Uint8Array(dh), reader.point, point);
			const mac = btoa(String.fromCharCode(...(await recordMac(secret, uri, cid))));
			return { [MAC_HEADER]: `type="atproto-space-record", ver=1, mac=:${mac}:` };
		}
	};
}

/** The key every DID in the shared fixtures publishes (./reader-host.ts,
 *  ./group-host.ts), so any of their hosts can MAC any of their records. */
export const fixtureKem = fakeKemHost();

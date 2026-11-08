// Two sets of fixed values. WANT and MAC were computed by @atproto/space (decapsulate,
// computeRecordMac, formatWantMacHeader, formatMacHeader) in the alpha image
// sha256:3ebb6d0e, for the request key below and a repo key whose public half is below.
// The code tested now calls @atproto/space itself, so these catch a version of it that
// asks for or reads a MAC differently. The RFC_ values are RFC 9180's own test keys and
// secret, with the MAC computed here, so the key exchange and the MAC are also checked
// against something other than the package.
import { fromString } from '@atcute/cid';
import { P256Keypair } from '@atproto/crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordMacCheck } from './space-mac';

const REPO_KEM_KEY = 'did:key:zDnaeQa8zprPhHA7Yuxcgc2Uh6XNQgaKjmFZE4EaA9fk5svmJ';
/** The request's own key, private scalar 0x22…22. */
const EPHEMERAL = new Uint8Array(32).fill(0x22);
const RECORD = {
	uri: 'at://did:plc:24sh6i7iuw4wqpqztvnzztob/space/group.opensocial.members/self/did:plc:24sh6i7iuw4wqpqztvnzztob/group.opensocial.acceptance/self',
	cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpm'
};
const WANT =
	'type="atproto-space-record", ver=1, key_share="did:key:zDnaex62me84JZnkEzmeYRa8FCLNe7y1asoSwBMK26GBYpL7c"';
const MAC =
	'type="atproto-space-record", ver=1, mac=:sJjfUqOgnziWAzGFWUoXUjiPtpVnW+VqfBD7jnaY1sE=:';

const hex = (text: string) => Uint8Array.from(text.match(/../g) ?? [], (b) => parseInt(b, 16));
// RFC 9180 A.3.1, DHKEM(P-256, HKDF-SHA256): skEm, skRm and shared_secret.
const RFC_REQUEST_KEY = hex('4995788ef4b9d6132b249ce59a77281493eb39af373d236a1fe415cb0c2d7beb');
const RFC_REPO_KEY = hex('f3ce7fdae57e1a310d87f1ebbde6f328be0a99cdbcadf4d6589cf29de4b8ffd2');
const RFC_SHARED_SECRET = hex('c0d26aeab536609a572b07695d933b589dcf363ff9d93c93adea537aeabb8cb8');

/** Each check makes a key of its own. This one gets a fixed key instead. */
async function fixedCheck(repoKemKey = REPO_KEM_KEY, requestKey = EPHEMERAL) {
	vi.spyOn(P256Keypair, 'create').mockResolvedValueOnce(await P256Keypair.import(requestKey));
	return recordMacCheck(repoKemKey);
}

/** HMAC-SHA256(secret, "atproto-space-record-v1" || uint16be(len(uri)) || uri || cid). */
async function macHeaderFor(secret: Uint8Array<ArrayBuffer>, uri: string, cid: string) {
	const uriBytes = new TextEncoder().encode(uri);
	const parts = [
		new TextEncoder().encode('atproto-space-record-v1'),
		Uint8Array.of(uriBytes.length >> 8, uriBytes.length & 0xff),
		uriBytes,
		fromString(cid).bytes
	];
	const data = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
	let at = 0;
	for (const part of parts) {
		data.set(part, at);
		at += part.length;
	}
	const key = await crypto.subtle.importKey(
		'raw',
		secret,
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, data));
	return `type="atproto-space-record", ver=1, mac=:${btoa(String.fromCharCode(...mac))}:`;
}

afterEach(() => vi.restoreAllMocks());

describe('recordMacCheck', () => {
	it('derives the secret RFC 9180 gives for its P-256 test keys, and checks the MAC over it', async () => {
		const repo = await P256Keypair.import(RFC_REPO_KEY);
		const check = await fixedCheck(repo.did(), RFC_REQUEST_KEY);
		const mac = await macHeaderFor(RFC_SHARED_SECRET, RECORD.uri, RECORD.cid);
		expect(check.verify(RECORD, mac)).toBe(true);
	});

	it('asks for the MAC as @atproto/space formats the request', async () => {
		expect((await fixedCheck()).header).toBe(WANT);
	});

	it('accepts the MAC the repo host computes for the record', async () => {
		expect((await fixedCheck()).verify(RECORD, MAC)).toBe(true);
	});

	it('refuses it for another record, another CID, or a MAC made for another request', async () => {
		const check = await fixedCheck();
		expect(check.verify({ ...RECORD, uri: `${RECORD.uri}x` }, MAC)).toBe(false);
		expect(
			check.verify(
				{ ...RECORD, cid: 'bafyreie5737gdxlw5i64vzichcalba3z2v5n6icifvx5xytvske7mr3hpa' },
				MAC
			)
		).toBe(false);
		const fresh = await recordMacCheck(REPO_KEM_KEY);
		expect(fresh.header).not.toBe(WANT);
		expect(fresh.verify(RECORD, MAC)).toBe(false);
	});

	it('refuses an answer with no MAC, or one for a commit or another version', async () => {
		const check = await fixedCheck();
		expect(check.verify(RECORD, null)).toBe(false);
		expect(check.verify(RECORD, MAC.replace('atproto-space-record', 'atproto-space-repo'))).toBe(
			false
		);
		expect(check.verify(RECORD, MAC.replace('ver=1', 'ver=2'))).toBe(false);
		expect(check.verify({ ...RECORD, cid: 'Qmnotbase32' }, MAC)).toBe(false);
	});
});

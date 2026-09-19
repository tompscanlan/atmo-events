// Where the app gets the right to write AS a group.
//
// A group is a custodial PDS account. The app holds that account's credential,
// so a group event is authored by the GROUP DID even though a human admin
// pressed the button — that is the entire point of the write gate
// ($lib/groups/server/event-writer.ts).
//
// ONE SOURCE: the `group_credentials` table (migrations/0002), written at mint.
// There was a second until 2026-09-19 — a `GROUP_CREDENTIALS` Worker secret
// holding a JSON map of group DID -> credential, read FIRST so an operator
// entry overrode a stored row. It predated the mint, and once create began
// minting its own accounts the secret's only remaining job was an operator
// override that a single D1 row does the same way. TS, on reading SC-007:
// *"if we don't need that var, drop it. it's confusing."* Deleted with nothing
// depending on it — the live worker never had the secret set, and the one
// minted group has never read it (`om-dnwi7`, FR-001f).
//
// ROTATION, since the override is gone: replace the `group_credentials` row
// and reset the account's app password out of band with
// `com.atproto.admin.updateAccountPassword`. That was always an admin action,
// so nothing regressed with the secret's removal.

export interface GroupCredential {
	/** PDS base URL, e.g. https://pds.opnmt.net */
	service: string;
	/** handle or DID the session is opened with */
	identifier: string;
	password: string;
}

// ---------------------------------------------------------------- minted credentials
//
// The credential comes into existence during a form POST, so it could never
// have lived in a Worker secret: a Worker cannot write its own. It lives in
// `group_credentials` (migrations/0002), AES-GCM encrypted under
// GROUP_CREDENTIAL_KEY, and what is stored is an APP PASSWORD — not the
// account's master password, which the mint discards. Rationale, measured source
// and the alternatives are in that migration's header; the short version is that
// a D1 read must not yield write-as-every-group, and must not yield account
// takeover even if it did decrypt.

export interface CredentialStoreEnv {
	/** base64 32-byte AES-GCM key. Without it a minted credential can neither be
	 *  written nor read, and the create flow refuses BEFORE minting rather than
	 *  stranding a did:plc it cannot store a credential for. */
	GROUP_CREDENTIAL_KEY?: string;
}

const KEY_BYTES = 32;
const IV_BYTES = 12;

function toBase64(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += String.fromCharCode(byte);
	return btoa(out);
}

function fromBase64(text: string): Uint8Array {
	const raw = atob(text);
	const bytes = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** Thrown when the deployment cannot store what it is about to mint. Named
 *  separately from GroupCredentialError so the create flow can refuse before the
 *  irreversible step instead of reporting a write failure afterwards. */
export class GroupCredentialKeyError extends Error {
	constructor(detail: string) {
		super(`GROUP_CREDENTIAL_KEY ${detail}`);
		this.name = 'GroupCredentialKeyError';
	}
}

async function aesKey(env: CredentialStoreEnv): Promise<CryptoKey> {
	const raw = env.GROUP_CREDENTIAL_KEY?.trim();
	if (!raw) throw new GroupCredentialKeyError('is not set on this deployment');
	let bytes: Uint8Array;
	try {
		bytes = fromBase64(raw);
	} catch {
		throw new GroupCredentialKeyError('is not valid base64');
	}
	if (bytes.length !== KEY_BYTES) {
		// The length is safe to name; the key never is.
		throw new GroupCredentialKeyError(`must decode to ${KEY_BYTES} bytes, got ${bytes.length}`);
	}
	return crypto.subtle.importKey('raw', bytes as BufferSource, 'AES-GCM', false, [
		'encrypt',
		'decrypt'
	]);
}

/** True when this deployment can mint — i.e. can store the credential it is
 *  about to receive exactly once. Checked before `createAccount`, never after. */
export async function canStoreMintedCredentials(env: CredentialStoreEnv): Promise<boolean> {
	try {
		await aesKey(env);
		return true;
	} catch {
		return false;
	}
}

/** Writes (or replaces) a minted group's credential. `password` here is the app
 *  password; the caller has already discarded the master. */
export async function storeGroupCredential(
	env: CredentialStoreEnv,
	db: D1Database,
	groupDid: string,
	cred: GroupCredential
): Promise<void> {
	const key = await aesKey(env);
	const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
	const ciphertext = await crypto.subtle.encrypt(
		{ name: 'AES-GCM', iv: iv as BufferSource },
		key,
		new TextEncoder().encode(cred.password) as BufferSource
	);
	const now = Date.now();
	await db
		.prepare(
			`INSERT INTO group_credentials (group_did, service, identifier, secret, iv, created_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (group_did) DO UPDATE SET
			   service = excluded.service,
			   identifier = excluded.identifier,
			   secret = excluded.secret,
			   iv = excluded.iv,
			   updated_at = excluded.updated_at`
		)
		.bind(
			groupDid,
			cred.service,
			cred.identifier,
			toBase64(new Uint8Array(ciphertext)),
			toBase64(iv),
			now,
			now
		)
		.run();
}

/** The credential to write as `groupDid`, or null if this deployment holds
 *  none. The stored row is the only source (FR-001f). */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	db: D1Database,
	groupDid: string
): Promise<GroupCredential | null> {
	const row = await db
		.prepare(`SELECT service, identifier, secret, iv FROM group_credentials WHERE group_did = ?`)
		.bind(groupDid)
		.first<{ service: string; identifier: string; secret: string; iv: string }>();
	if (!row) return null;

	const key = await aesKey(env);
	const plaintext = await crypto.subtle.decrypt(
		{ name: 'AES-GCM', iv: fromBase64(row.iv) as BufferSource },
		key,
		fromBase64(row.secret) as BufferSource
	);
	return {
		service: row.service,
		identifier: row.identifier,
		password: new TextDecoder().decode(plaintext)
	};
}

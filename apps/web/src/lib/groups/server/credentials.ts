// Where the app gets the right to write as a group: the `group_credentials` row
// written at create (migrations/0002_group_credentials.sql says why). An app-password
// session cannot create an app password, so rotation goes through
// com.atproto.admin.updateAccountPassword and then replaces the row.

import { ensureGroupsSchema } from './schema';

export interface GroupCredential {
	service: string;
	/** The handle or DID the session is opened with. */
	identifier: string;
	password: string;
}

export interface CredentialStoreEnv {
	/** Base64 32-byte AES-GCM key. Without it the create flow refuses before minting,
	 *  rather than leave a did:plc it cannot store a credential for. */
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

/** Separate from GroupCredentialError so the create flow can refuse before the step
 *  that cannot be undone. */
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

/** Whether this deployment can store the credential a mint returns only once. Ask
 *  before `createAccount`. */
export async function canStoreMintedCredentials(env: CredentialStoreEnv): Promise<boolean> {
	try {
		await aesKey(env);
		return true;
	} catch {
		return false;
	}
}

/** Writes or replaces a group's credential. `password` is the app password. */
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
	await ensureGroupsSchema(db);
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

/** The credential to write as `groupDid`, or null if this deployment holds none. */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	db: D1Database,
	groupDid: string
): Promise<GroupCredential | null> {
	await ensureGroupsSchema(db);
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

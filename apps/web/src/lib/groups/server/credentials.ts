// Where the app gets the right to write AS a group.
//
// A group is a custodial PDS account. The app holds that account's credential,
// so a group event is authored by the GROUP DID even though a human admin
// pressed the button — that is the entire point of the write gate
// ($lib/groups/server/event-writer.ts).
//
// Credentials come from one Worker secret, GROUP_CREDENTIALS: a JSON map of
// group DID -> { service, identifier, password }. One secret keeps the number
// of moving parts fixed as groups are added, and the map form is what a
// multi-group deployment needs anyway.
//
//   wrangler secret put GROUP_CREDENTIALS
//   {"did:plc:jcwgw6fcnb5vyoid7nz7sl26":{"service":"https://pds.opnmt.net",
//     "identifier":"spike-group.opnmt.net","password":"…"}}
//
// Local dev reads the same name out of apps/web/.dev.vars. The value is a
// secret and must never be logged: `credentialFor` returns it, and nothing in
// this tree prints it.

export interface GroupCredential {
	/** PDS base URL, e.g. https://pds.opnmt.net */
	service: string;
	/** handle or DID the session is opened with */
	identifier: string;
	password: string;
}

type CredentialEnv = { GROUP_CREDENTIALS?: string };

interface ParsedCredentials {
	source: string;
	byDid: Record<string, GroupCredential>;
}

let parsed: ParsedCredentials | null = null;

function parse(raw: string): Record<string, GroupCredential> {
	const decoded: unknown = JSON.parse(raw);
	if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
		throw new Error('GROUP_CREDENTIALS must be a JSON object keyed by group DID');
	}
	const byDid: Record<string, GroupCredential> = {};
	for (const [did, value] of Object.entries(decoded as Record<string, unknown>)) {
		if (!did.startsWith('did:')) {
			throw new Error(`GROUP_CREDENTIALS key ${JSON.stringify(did)} is not a DID`);
		}
		const cred = value as Partial<GroupCredential> | null;
		if (
			!cred ||
			typeof cred.service !== 'string' ||
			typeof cred.identifier !== 'string' ||
			typeof cred.password !== 'string'
		) {
			// The DID is safe to name; the value never is.
			throw new Error(`GROUP_CREDENTIALS[${did}] needs service, identifier and password`);
		}
		byDid[did] = { service: cred.service, identifier: cred.identifier, password: cred.password };
	}
	return byDid;
}

/** Parsed once per isolate, re-parsed if the secret's text changes (it does in
 *  dev, where .dev.vars is reloaded). A malformed secret throws HERE rather
 *  than at write time, so it surfaces on the first group request. */
export function groupCredentials(env: CredentialEnv): Record<string, GroupCredential> {
	const raw = env.GROUP_CREDENTIALS?.trim();
	if (!raw) return {};
	if (parsed?.source !== raw) parsed = { source: raw, byDid: parse(raw) };
	return parsed.byDid;
}

export function credentialFor(env: CredentialEnv, groupDid: string): GroupCredential | null {
	return groupCredentials(env)[groupDid] ?? null;
}

// ---------------------------------------------------------------- minted credentials
//
// A minted group's credential cannot live in GROUP_CREDENTIALS: a Worker cannot
// write its own secret, and the credential comes into existence during a form
// POST. It lives in `group_credentials` (migrations/0002), AES-GCM encrypted
// under GROUP_CREDENTIAL_KEY, and what is stored is an APP PASSWORD — not the
// account's master password, which the mint discards. Rationale, measured source
// and the alternatives are in that migration's header; the short version is that
// a D1 read must not yield write-as-every-group, and must not yield account
// takeover even if it did decrypt.

export interface CredentialStoreEnv extends CredentialEnv {
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

/** The credential to write as `groupDid`, or null if this deployment holds none.
 *
 *  SECRET FIRST, TABLE SECOND — so an operator entry always overrides a stored
 *  row (rotate a credential, repoint a group at another PDS) with no migration
 *  and no delete. */
export async function resolveGroupCredential(
	env: CredentialStoreEnv,
	db: D1Database,
	groupDid: string
): Promise<GroupCredential | null> {
	const configured = credentialFor(env, groupDid);
	if (configured) return configured;

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

// Where the app gets the right to write AS a group.
//
// A group is a custodial PDS account. The app holds that account's credential,
// so a group event is authored by the GROUP DID even though a human admin
// pressed the button — that is the entire point of the write gate
// ($lib/groups/server/event-writer.ts, bead om-3e5i).
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

/** DIDs this deployment can currently write as — the only DIDs a group may be
 *  bound to at creation. Sorted so the create form's options are stable. */
export function custodialDids(env: CredentialEnv): string[] {
	return Object.keys(groupCredentials(env)).sort();
}

/** THE MINTING SEAM, DELIBERATELY OFF.
 *
 *  Creating a group does NOT mint a did:plc. A did:plc is a permanent public
 *  identity written to plc.directory; it cannot be recalled, and minting one is
 *  a decision a human authorises, not a side effect of a form POST. So v1 binds
 *  an EXISTING custodial DID supplied by config (`GROUP_CREDENTIALS`) or by the
 *  operator typing it into /groups/create.
 *
 *  When automatic minting is implemented it plugs in here: flip this to true,
 *  and `createGroup` will ask for a freshly minted DID instead of rejecting a
 *  request that names no known DID. There is no stub behind it on purpose —
 *  a fake mint that returned a placeholder DID would produce groups whose
 *  records can never be written, which is worse than a clear refusal. */
export const AUTO_MINT_GROUP_DID = false;

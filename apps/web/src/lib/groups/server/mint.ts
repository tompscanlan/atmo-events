// Minting a group: a did:plc, a handle, a writing credential, and a rotation key
// the OWNER holds.
//
// Why this exists at all (FR-001): before it, group creation bound a
// pre-provisioned DID out of GROUP_CREDENTIALS, so nobody but an operator could
// create a group. The public alpha requires self-service.
//
// THE HANDLE REGISTRATION IS THE NAME RESERVATION (FR-001a). The PDS's handle
// registry adjudicates the collision, so a duplicate name fails HERE — before a
// did:plc exists, before a row, before a space. That is the whole reason the
// order is mint-then-INSERT and not the other way around: a did:plc is permanent
// and unrecallable, so it must be the last thing risked, and the first thing a
// clash stops.
//
// WHAT THE OWNER GETS, AND WHAT WE KEEP (FR-001f/FR-001g):
//   * the owner gets rotationKeys[0] of the genesis operation, so they can move
//     the DID off our PDS without our cooperation. The private key is returned to
//     the caller for a ONE-TIME reveal and is never stored or logged here.
//   * we keep an APP PASSWORD, which writes as the group but cannot change the
//     password or delete the account. The random master used to create it is
//     discarded inside `mintGroupAccount` and never leaves this module.
import { Secp256k1PrivateKeyExportable } from '@atcute/crypto';
import type { GroupCredential } from './credentials';

/** Where a mint happens, and with what. All four are required: a deployment
 *  missing any of them cannot mint, which the create flow reports BEFORE taking
 *  an irreversible step. */
export interface MintConfig {
	/** PDS base URL, e.g. https://pds.opnmt.net (`GROUP_PDS_SERVICE`). */
	service: string;
	/** Handle suffix for groups, e.g. group.opnmt.net (`GROUP_HANDLE_DOMAIN`).
	 *  Groups get their OWN subdomain so a group handle can never lose a race to
	 *  a member handle — FR-001b, and `om-kp7ss.5` puts members on the same PDS. */
	handleDomain: string;
	/** The deployment's invite code (`GROUP_PDS_INVITE_CODE`). PDS_INVITE_REQUIRED
	 *  is true on the alpha; we hold a code rather than opening the gate. */
	inviteCode: string;
	/** Address group accounts are created with, e.g. groups@openmeet.net
	 *  (`GROUP_ACCOUNT_EMAIL`). Plus-addressed per group — FR-001h. */
	accountEmail: string;
}

/** Why a mint did not happen. Every value is a case the create form must render
 *  as something a user or an operator can act on — never a raw PDS error. */
export type MintFailure =
	/** The label is taken, or the PDS reserves it (~1000 names we deliberately do
	 *  not mirror; `slugMintRefusal` catches only the protocol's own list). */
	| 'handle-taken'
	/** The PDS rejected the label's shape. `slugMintRefusal` should have caught
	 *  this first, so reaching it means our rules and the PDS's have drifted. */
	| 'handle-invalid'
	/** No invite code configured on this deployment. */
	| 'invite-missing'
	/** Exhausted, nonexistent, disabled or taken-down — the PDS gives all four the
	 *  same string, and FR-001e forbids using admin credentials to tell them
	 *  apart from the request path. An operator page, never a user-facing blame. */
	| 'invite-unavailable'
	/** The account address was refused (invalid, disposable, or already used). */
	| 'email-rejected'
	/** The PDS did not answer, or answered in a shape we do not understand. */
	| 'pds-unreachable'
	/** The mint succeeded but the owner's key is NOT rotationKeys[0], so the group
	 *  is not portable and must not be presented as if it were. */
	| 'rotation-key-unverified';

export class GroupMintError extends Error {
	constructor(
		readonly failure: MintFailure,
		message: string
	) {
		super(message);
		this.name = 'GroupMintError';
	}
}

export interface MintedGroup {
	did: string;
	handle: string;
	/** The app password, ready to store. The master password that created it no
	 *  longer exists anywhere by the time this returns. */
	credential: GroupCredential;
	/** The owner's PLC rotation key, `did:key:…`. Public half — safe to log. */
	ownerRotationKey: string;
	/** The owner's private key, multibase. REVEAL ONCE, STORE NEVER. */
	ownerRotationSecret: string;
}

/** 32 bytes of base64url. Long enough that the PDS's strength rules are moot,
 *  and it lives for exactly the two calls it takes to create an app password. */
function randomPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `groups@openmeet.net` + `kona` -> `groups+kona@openmeet.net`.
 *
 *  Per-group uniqueness is required, not cosmetic: `getAccountByEmail` is
 *  exact-match, so a shared address makes the second mint fail with
 *  `Email already taken`. */
function accountEmailFor(template: string, slug: string): string {
	const at = template.lastIndexOf('@');
	if (at <= 0) {
		throw new GroupMintError(
			'email-rejected',
			`GROUP_ACCOUNT_EMAIL ${JSON.stringify(template)} is not an address`
		);
	}
	return `${template.slice(0, at)}+${slug}@${template.slice(at + 1)}`;
}

async function xrpc(
	service: string,
	nsid: string,
	body: unknown,
	token?: string
): Promise<Response> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (token) headers.authorization = `Bearer ${token}`;
	try {
		return await fetch(new URL(`/xrpc/${nsid}`, service), {
			method: 'POST',
			headers,
			body: JSON.stringify(body)
		});
	} catch (e) {
		throw new GroupMintError('pds-unreachable', `${service} did not answer ${nsid}: ${String(e)}`);
	}
}

/** Maps a PDS refusal onto a `MintFailure`.
 *
 *  Read at source 2026-09-17: a missing code is its own message
 *  (`createAccount.ts:224-229` -> 'No invite code provided'), while spent,
 *  nonexistent, disabled and taken-down are one identical string
 *  (`invite.ts:107-112`, `:120-124`). That collapse is why `invite-unavailable`
 *  exists as one case rather than two we would be pretending to distinguish. */
function mintFailureFor(error: string | null, message: string | null): MintFailure {
	if (error === 'HandleNotAvailable') return 'handle-taken';
	if (error === 'InvalidHandle') return 'handle-invalid';
	if (error === 'InvalidInviteCode') {
		return message?.includes('No invite code provided') ? 'invite-missing' : 'invite-unavailable';
	}
	if (message && /email/i.test(message)) return 'email-rejected';
	return 'pds-unreachable';
}

async function refusal(res: Response): Promise<GroupMintError> {
	let error: string | null = null;
	let message: string | null = null;
	try {
		const body = (await res.json()) as { error?: string; message?: string };
		error = body.error ?? null;
		message = body.message ?? null;
	} catch {
		// A non-JSON body from a PDS is itself the diagnosis; keep the status.
	}
	const failure = mintFailureFor(error, message);
	// `message` can name a handle or an email address, never a password — the
	// PDS does not echo one and nothing here puts one in an error.
	return new GroupMintError(
		failure,
		`${res.status} ${error ?? 'error'}: ${message ?? 'no detail'}`
	);
}

/** Reads the genesis operation back and proves the owner's key comes first.
 *
 *  Rotation keys are NOT in the DID document — they live in the PLC operation, so
 *  this asks plc.directory rather than resolving the DID. `rotationKeys[0]` is
 *  the whole claim: PLC resolves conflicting operations by key precedence, so
 *  index 0 is what lets the owner move the DID against our wishes. Anything else
 *  means we minted an identity only we can move (FR-001g, `om-bhj4y`). */
export async function assertOwnerHoldsRotationKey(
	did: string,
	ownerRotationKey: string,
	plcDirectory = 'https://plc.directory'
): Promise<void> {
	let rotationKeys: unknown;
	try {
		const res = await fetch(new URL(`/${did}/data`, plcDirectory));
		if (!res.ok) {
			throw new GroupMintError(
				'rotation-key-unverified',
				`plc.directory answered ${res.status} for ${did}`
			);
		}
		({ rotationKeys } = (await res.json()) as { rotationKeys?: unknown });
	} catch (e) {
		if (e instanceof GroupMintError) throw e;
		throw new GroupMintError(
			'rotation-key-unverified',
			`cannot read ${did}'s PLC data: ${String(e)}`
		);
	}
	if (!Array.isArray(rotationKeys) || rotationKeys[0] !== ownerRotationKey) {
		throw new GroupMintError(
			'rotation-key-unverified',
			`${did} rotationKeys[0] is ${JSON.stringify(
				Array.isArray(rotationKeys) ? rotationKeys[0] : rotationKeys
			)}, not the owner's key`
		);
	}
}

/** Mints the account for `slug` and returns everything the caller must persist or
 *  reveal. Does NOT touch D1 and does NOT provision spaces — the caller orders
 *  those, because only it knows what a failure would strand.
 *
 *  `verifyRotationKey` is the seam tests replace; the live path always checks. */
export async function mintGroupAccount(
	cfg: MintConfig,
	slug: string,
	verifyRotationKey: (did: string, key: string) => Promise<void> = assertOwnerHoldsRotationKey
): Promise<MintedGroup> {
	if (!cfg.inviteCode) {
		throw new GroupMintError('invite-missing', 'this deployment has no GROUP_PDS_INVITE_CODE');
	}
	const handle = `${slug}.${cfg.handleDomain}`;
	const email = accountEmailFor(cfg.accountEmail, slug);

	// The owner's key is generated FIRST: it has to be in the genesis operation,
	// and generating it costs nothing that a later failure would strand.
	const ownerKey = await Secp256k1PrivateKeyExportable.createKeypair();
	const ownerRotationKey = await ownerKey.exportPublicKey('did');
	const ownerRotationSecret = await ownerKey.exportPrivateKey('multikey');

	// Discarded before this function returns. It exists only because
	// createAppPassword requires ACCESS_FULL, which an app password never has.
	const master = randomPassword();

	const created = await xrpc(cfg.service, 'com.atproto.server.createAccount', {
		handle,
		email,
		password: master,
		inviteCode: cfg.inviteCode,
		recoveryKey: ownerRotationKey
	});
	if (!created.ok) throw await refusal(created);

	let session: { did: string; handle: string; accessJwt: string };
	try {
		session = (await created.json()) as { did: string; handle: string; accessJwt: string };
	} catch (e) {
		throw new GroupMintError('pds-unreachable', `createAccount returned no session: ${String(e)}`);
	}

	// One app password, created with the master session, named so an operator
	// reading listAppPasswords can tell what holds it.
	const issued = await xrpc(
		cfg.service,
		'com.atproto.server.createAppPassword',
		{ name: 'openmeet-group-writer' },
		session.accessJwt
	);
	if (!issued.ok) throw await refusal(issued);
	let appPassword: string;
	try {
		({ password: appPassword } = (await issued.json()) as { password: string });
	} catch (e) {
		throw new GroupMintError(
			'pds-unreachable',
			`createAppPassword returned no password: ${String(e)}`
		);
	}

	// Before the caller is told this group exists: if the owner's key did not land
	// first, we minted an identity only we can move. Surface it (FR-001g).
	await verifyRotationKey(session.did, ownerRotationKey);

	return {
		did: session.did,
		handle: session.handle ?? handle,
		credential: {
			service: cfg.service,
			identifier: session.handle ?? handle,
			password: appPassword
		},
		ownerRotationKey,
		ownerRotationSecret
	};
}

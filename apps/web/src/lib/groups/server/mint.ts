// Minting a group: a did:plc, a handle, a writing credential, and a rotation key
// that the owner holds.
//
// REGISTERING THE HANDLE IS THE NAME RESERVATION. The PDS's handle registry
// decides collisions, so a duplicate name fails here, before a did:plc exists,
// before a row and before a space. A did:plc is permanent and cannot be taken
// back, so it must be the last thing a create risks. That is why the create
// flow mints first and inserts the row after.
//
// What the owner gets, and what we keep:
//   * The owner gets rotationKeys[0] of the genesis operation, so they can move
//     the DID off our PDS without our help. The private key is returned to the
//     caller to show once. It is never stored or logged here.
//   * We keep an app password. It writes as the group, but it cannot change the
//     account password or delete the account. The random account password used
//     to create it is discarded inside `mintGroupAccount` and never leaves this
//     module.
import { Secp256k1PrivateKeyExportable } from '@atcute/crypto';
import type { GroupCredential } from './credentials';

/** Where a mint happens, and with what. All four are required: a deployment
 *  missing any of them cannot mint, and the create flow says so before it takes
 *  a step that cannot be undone. */
export interface MintConfig {
	/** PDS base URL, e.g. https://pds.example.com (`GROUP_PDS_SERVICE`). */
	service: string;
	/** Handle suffix for groups, e.g. groups.example.com (`GROUP_HANDLE_DOMAIN`).
	 *  Groups get their own subdomain so a group handle never competes with a
	 *  person's handle when people also have accounts on this PDS. In one shared
	 *  namespace, a person's name could decide whether a group can be created. */
	handleDomain: string;
	/** The invite code group accounts are created with
	 *  (`GROUP_PDS_INVITE_CODE`). The deployment holds its own code, so the PDS
	 *  can keep requiring invites. */
	inviteCode: string;
	/** Address group accounts are created with, e.g. groups@example.com
	 *  (`GROUP_ACCOUNT_EMAIL`). Plus-addressed per group, because the PDS matches
	 *  account emails exactly and refuses an account with no email. The address
	 *  is ours, not the owner's, so password reset mail comes to us. */
	accountEmail: string;
}

/** Why a mint did not happen. The create form renders each value as something
 *  a user or an operator can act on, never as a raw PDS error. */
export type MintFailure =
	/** The label is taken, or the PDS reserves it. The PDS reserves about 1000
	 *  names that we do not copy; `labelMintRefusal` checks only the protocol's
	 *  own list. */
	| 'handle-taken'
	/** The PDS rejected the label's shape. `labelMintRefusal` should catch this
	 *  first, so reaching it means our rules and the PDS's rules differ. */
	| 'handle-invalid'
	/** No invite code configured on this deployment. */
	| 'invite-missing'
	/** The code is used up, does not exist, is disabled or was taken down. The
	 *  PDS returns the same message for all four. Telling them apart needs admin
	 *  credentials, and the create path must not hold them: a public Worker with
	 *  an admin password could take down any account on the host. This is for an
	 *  operator to fix, and the user is not blamed. */
	| 'invite-unavailable'
	/** The account address was refused (invalid, disposable, or already used). */
	| 'email-rejected'
	/** The PDS did not answer, or answered in a shape we do not understand. */
	| 'pds-unreachable'
	/** The account was created, but the owner's key is not rotationKeys[0], so
	 *  the group is not portable and must not be presented as if it were. */
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
	/** The app password, ready to store. The account password that created it
	 *  no longer exists anywhere by the time this returns. */
	credential: GroupCredential;
	/** The owner's PLC rotation key, `did:key:…`. The public half, safe to log. */
	ownerRotationKey: string;
	/** The owner's private key, multibase. Show it once; never store it. */
	ownerRotationSecret: string;
}

/** 32 random bytes as base64url. Long enough that the PDS's strength rules do
 *  not matter, and it lives only for the two calls it takes to create an app
 *  password. */
function randomPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `groups@example.com` + `kona` -> `groups+kona@example.com`, where `kona` is
 *  the handle label of the new account.
 *
 *  Each group needs its own address: the PDS looks accounts up by exact email,
 *  so a shared address makes the second mint fail with `Email already taken`. */
function accountEmailFor(template: string, label: string): string {
	const at = template.lastIndexOf('@');
	if (at <= 0) {
		throw new GroupMintError(
			'email-rejected',
			`GROUP_ACCOUNT_EMAIL ${JSON.stringify(template)} is not an address`
		);
	}
	return `${template.slice(0, at)}+${label}@${template.slice(at + 1)}`;
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
 *  The message decides, and the error name is the fallback. On createAccount
 *  a taken handle arrives as `{"error":"InvalidRequest","message":"Handle
 *  already taken: <handle>"}`, not as `HandleNotAvailable`: the createAccount
 *  pre-check throws a plain InvalidRequestError, and only a later path in the
 *  PDS uses the `HandleNotAvailable` name. Keying on the name alone would report
 *  the most common failure, "that name is taken", as `pds-unreachable`.
 *
 *  A missing invite code has its own message ('No invite code provided'). A
 *  code that is used up, does not exist, is disabled or was taken down gets one
 *  identical message, so `invite-unavailable` is one case, not several we could
 *  not really tell apart. */
function mintFailureFor(error: string | null, message: string | null): MintFailure {
	if (error === 'HandleNotAvailable') return 'handle-taken';
	if (message && /handle already taken/i.test(message)) return 'handle-taken';
	if (error === 'InvalidHandle') return 'handle-invalid';
	// Checked before the generic /email/i so the two "already taken" refusals,
	// which differ by one word, cannot collapse into each other.
	if (message && /email already taken/i.test(message)) return 'email-rejected';
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
	// `message` can name a handle or an email address, never a password: the
	// PDS does not echo one, and nothing here puts one in an error.
	return new GroupMintError(
		failure,
		`${res.status} ${error ?? 'error'}: ${message ?? 'no detail'}`
	);
}

/** Reads the genesis operation back and checks that the owner's key is first.
 *
 *  Rotation keys are not in the DID document. They live in the PLC operation,
 *  so this asks plc.directory rather than resolving the DID. Index 0 is what
 *  matters: PLC resolves conflicting operations by key order, so the key at
 *  index 0 lets the owner move the DID even against our wishes. Anything else
 *  means we minted an identity only we can move. */
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

/** Mints the account for the handle `<label>.<handleDomain>`. The label is not
 *  stored anywhere: the handle is the group's name reservation, and the DID is
 *  what everything is keyed on afterwards. Returns everything the caller must
 *  store or show. It does not touch D1 and does not create spaces. The caller
 *  orders those, because only it knows what a failure would leave behind.
 *
 *  Tests replace `verifyRotationKey`; the live path always checks. */
export async function mintGroupAccount(
	cfg: MintConfig,
	label: string,
	verifyRotationKey: (did: string, key: string) => Promise<void> = assertOwnerHoldsRotationKey
): Promise<MintedGroup> {
	if (!cfg.inviteCode) {
		throw new GroupMintError('invite-missing', 'this deployment has no GROUP_PDS_INVITE_CODE');
	}
	const handle = `${label}.${cfg.handleDomain}`;
	const email = accountEmailFor(cfg.accountEmail, label);

	// The owner's key is generated first. It has to be in the genesis operation,
	// and generating it leaves nothing behind if a later step fails.
	const ownerKey = await Secp256k1PrivateKeyExportable.createKeypair();
	const ownerRotationKey = await ownerKey.exportPublicKey('did');
	const ownerRotationSecret = await ownerKey.exportPrivateKey('multikey');

	// The account password, discarded before this function returns. It exists
	// only because createAppPassword requires ACCESS_FULL, which an app
	// password never has.
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

	// One app password, created with the account-password session, and named so
	// an operator reading listAppPasswords can tell what holds it.
	const issued = await xrpc(
		cfg.service,
		'com.atproto.server.createAppPassword',
		{ name: 'group-writer' },
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

	// Checked before the caller is told the group exists. If the owner's key is
	// not first, we minted an identity only we can move, and the group is not
	// really portable. Fail rather than return it.
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

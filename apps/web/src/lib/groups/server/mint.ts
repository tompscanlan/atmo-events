// Minting a group: a did:plc, a handle, a writing credential, and a rotation key the
// owner holds. Registering the handle is the name reservation, so a duplicate name
// fails here, before a did:plc, a row or a space exists. The owner's key is
// rotationKeys[0], so they can move the DID without us. We keep only an app password.
import { Secp256k1PrivateKeyExportable } from '@atcute/crypto';
import type { GroupCredential } from './credentials';

/** All four are required. The create flow checks them before a step that cannot be undone. */
export interface MintConfig {
	/** PDS base URL (`GROUP_PDS_SERVICE`). */
	service: string;
	/** Handle suffix for groups (`GROUP_HANDLE_DOMAIN`). A subdomain of its own, so a
	 *  person's handle on the same PDS can never block a group name. */
	handleDomain: string;
	/** `GROUP_PDS_INVITE_CODE`, so the PDS can keep requiring invites. */
	inviteCode: string;
	/** `GROUP_ACCOUNT_EMAIL`, plus-addressed per group. The address is ours, not the
	 *  owner's, so password reset mail comes to us. */
	accountEmail: string;
}

/** Why a mint did not happen, in terms the create form can explain. */
export type MintFailure =
	/** Taken, or one of the PDS's reserved names that we do not mirror. */
	| 'handle-taken'
	/** `labelMintRefusal` should catch this first, so our rules and the PDS's differ. */
	| 'handle-invalid'
	/** No invite code configured. */
	| 'invite-missing'
	/** Used up, missing, disabled or taken down. The PDS gives one message for all four,
	 *  and telling them apart needs admin credentials the create path must not hold. */
	| 'invite-unavailable'
	/** Invalid, disposable, or already used. */
	| 'email-rejected'
	/** The PDS did not answer, or answered in a shape we do not understand. */
	| 'pds-unreachable'
	/** The owner's key is not rotationKeys[0], so the group is not portable. */
	| 'rotation-key-unverified';

/** An account the mint created before it failed. `recoveryKey` is the only copy of
 *  the owner's rotation key. */
export interface RegisteredAccount {
	did: string;
	handle: string;
	recoveryKey: string;
}

export class GroupMintError extends Error {
	constructor(
		readonly failure: MintFailure,
		message: string,
		/** Set when the failure came after createAccount succeeded. */
		readonly registered?: RegisteredAccount
	) {
		super(message);
		this.name = 'GroupMintError';
	}
}

export interface MintedGroup {
	did: string;
	handle: string;
	/** The app password, ready to store. The account password is already gone. */
	credential: GroupCredential;
	/** `did:key:…`, the public half. */
	ownerRotationKey: string;
	/** The owner's private key, multibase. Show it once; never store it. */
	ownerRotationSecret: string;
}

/** Lives only for the two calls it takes to create an app password. */
function randomPassword(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let raw = '';
	for (const byte of bytes) raw += String.fromCharCode(byte);
	return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** `groups@example.com` + `hiking` -> `groups+hiking@example.com`. The PDS matches
 *  emails exactly, so a shared address would fail the second mint. */
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

/** Maps a PDS refusal onto a `MintFailure`, by message first. createAccount reports a
 *  taken handle as `InvalidRequest` with "Handle already taken", not as
 *  `HandleNotAvailable`, so the error name alone would miss the most common case. */
function mintFailureFor(error: string | null, message: string | null): MintFailure {
	if (error === 'HandleNotAvailable') return 'handle-taken';
	if (message && /handle already taken/i.test(message)) return 'handle-taken';
	if (error === 'InvalidHandle') return 'handle-invalid';
	// Checked before the generic /email/i, so the two "already taken" refusals stay apart.
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
	// The PDS never echoes a password, so `message` is safe to keep.
	return new GroupMintError(
		failure,
		`${res.status} ${error ?? 'error'}: ${message ?? 'no detail'}`
	);
}

/** Reads the genesis operation from plc.directory, since rotation keys are not in the
 *  DID document, and checks that the owner's key is first. PLC resolves conflicting
 *  operations by key order, so index 0 lets the owner move the DID even against us. */
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

/** Mints the account for `<label>.<handleDomain>`. It does not touch D1 or create
 *  spaces: the caller orders those, since only it knows what a failure leaves behind.
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

	// The owner's key goes into the genesis operation, so it comes first.
	const ownerKey = await Secp256k1PrivateKeyExportable.createKeypair();
	const ownerRotationKey = await ownerKey.exportPublicKey('did');
	const ownerRotationSecret = await ownerKey.exportPrivateKey('multikey');

	// Discarded before return. It exists only because createAppPassword requires
	// ACCESS_FULL, which an app password never has.
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

	// From here the did:plc exists, so a failure below still hands back the owner's key.
	const registered: RegisteredAccount = {
		did: session.did,
		handle: session.handle ?? handle,
		recoveryKey: ownerRotationSecret
	};
	let appPassword: string;
	try {
		// Named so an operator reading listAppPasswords can tell what holds it.
		const issued = await xrpc(
			cfg.service,
			'com.atproto.server.createAppPassword',
			{ name: 'group-writer' },
			session.accessJwt
		);
		if (!issued.ok) throw await refusal(issued);
		try {
			({ password: appPassword } = (await issued.json()) as { password: string });
		} catch (e) {
			throw new GroupMintError(
				'pds-unreachable',
				`createAppPassword returned no password: ${String(e)}`
			);
		}

		// Before the caller is told the group exists: an identity only we can move is
		// not portable.
		await verifyRotationKey(session.did, ownerRotationKey);
	} catch (e) {
		if (e instanceof GroupMintError) throw new GroupMintError(e.failure, e.message, registered);
		throw new GroupMintError('pds-unreachable', String(e), registered);
	}

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

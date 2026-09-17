// GROUP CREATION, as a plain function.
//
// The body lives here rather than in `groups.remote.ts` for the reason
// `$lib/contrail/events-load-more.ts` names: the Vite plugin rejects non-remote
// exports from `*.remote.ts`, so a handler that only exists inside `form()`
// cannot be called by a test. `createGroupForm` is the thin wrapper that
// supplies `locals.did` and `platform.env`; everything that can go wrong lives
// here, where it is assertable.
//
// THE ORDER IS THE POINT (FR-001a, SC-008). A did:plc is permanent and
// unrecallable, so the sequence is:
//
//   refuse -> refuse -> mint -> store -> INSERT -> provision
//
// Both refusals come BEFORE the mint: a label the PDS would reject, and a
// deployment that could not keep the credential the mint hands back exactly
// once. The handle registration is itself the name reservation, so a duplicate
// name fails at the mint and leaves nothing behind — no DID, no row, no space.
import type { CredentialStoreEnv } from './server/credentials';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	storeGroupCredential
} from './server/credentials';
import { GroupMintError, mintGroupAccount, type MintConfig, type MintFailure } from './server/mint';
import { createGroup, recordGroupSpaces } from './server/repo';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { slugMintRefusal, slugMintRefusalMessage } from './slug';
import { formError } from './form-error';
import type { GroupFormResult } from './form-result';
import type { GroupStatus, GroupVisibility } from './types';

/** The five settings a mint needs, plus the group tables. Structural rather
 *  than `App.Platform['env']` so a test can supply exactly this much. */
export interface CreateGroupEnv extends CredentialStoreEnv {
	DB: D1Database;
	GROUP_PDS_SERVICE?: string;
	GROUP_HANDLE_DOMAIN?: string;
	GROUP_PDS_INVITE_CODE?: string;
	GROUP_ACCOUNT_EMAIL?: string;
}

/** The validated form payload. `createGroupForm`'s valibot schema is checked
 *  against this shape at the callsite, so the two cannot drift silently. */
export interface CreateGroupData {
	name: string;
	slug: string;
	description?: string;
	visibility: GroupVisibility;
	status: GroupStatus;
	/** Optional because an unticked HTML checkbox sends nothing at all; `repo.ts`
	 *  reads a missing value as `true` (`require_approval` defaults to 1). */
	requireApproval?: boolean;
	locationName?: string;
	locationAddress?: string;
	locationTimezone?: string;
}

export type CreateGroupOutcome = GroupFormResult<{ groupSlug: string; recoveryKey: string }>;

/** The mint target, or null when this deployment is not configured to mint. All
 *  four values are required: a partial configuration is an operator error, and
 *  finding out mid-flight would mean discovering it after a did:plc exists. */
export function mintConfig(env: CreateGroupEnv): MintConfig | null {
	const service = env.GROUP_PDS_SERVICE?.trim();
	const handleDomain = env.GROUP_HANDLE_DOMAIN?.trim();
	const inviteCode = env.GROUP_PDS_INVITE_CODE?.trim();
	const accountEmail = env.GROUP_ACCOUNT_EMAIL?.trim();
	if (!service || !handleDomain || !inviteCode || !accountEmail) return null;
	return { service, handleDomain, inviteCode, accountEmail };
}

/** What a failed mint says to whoever is reading the form.
 *
 *  The user's cases name the field they can change. The operator's cases say
 *  "not you, and not your fault" WITHOUT guessing a cause: FR-001e forbids the
 *  create path from calling `com.atproto.admin.getInviteCodes`, so an unavailable
 *  code is genuinely ambiguous between exhausted and misconfigured, and claiming
 *  either would be a fabrication. `om-pl5pw` owns the detection. */
export function mintErrorMessage(
	e: { failure: MintFailure; message: string },
	slug: string
): string {
	const operatorAlert = `Group creation is temporarily unavailable. This is a deployment problem, not something you did — please try again later or tell an administrator. (${e.failure})`;
	switch (e.failure) {
		case 'handle-taken':
			return `“${slug}” is already taken. Choose another URL name.`;
		case 'handle-invalid':
			return `The group PDS refused “${slug}” as an address. Choose another URL name.`;
		case 'rotation-key-unverified':
			// Deliberately not swallowed: the group would exist without the owner
			// holding rotationKeys[0], i.e. portable in name only (FR-001g).
			return `“${slug}” was registered, but we could not confirm that you hold its recovery key, so it has not been set up as your group. Tell an administrator before creating it again. (${e.message})`;
		case 'invite-missing':
		case 'invite-unavailable':
		case 'email-rejected':
		case 'pds-unreachable':
			return operatorAlert;
	}
}

export async function runCreateGroup(
	env: CreateGroupEnv,
	callerDid: string,
	data: CreateGroupData
): Promise<CreateGroupOutcome> {
	// REFUSE BEFORE MINTING, in two ways, because a did:plc cannot be recalled.
	//
	// 1. The label must be one the PDS will accept as a handle. Our slug rules
	//    are wider than its handle rules (3-18, no dot, not reserved), and the
	//    handle registration IS the name reservation (FR-001a), so a label we
	//    could not mint must fail on the field the user can edit.
	const refusal = slugMintRefusal(data.slug);
	if (refusal) return { ok: false, error: slugMintRefusalMessage(refusal, data.slug) };

	// 2. The deployment must be able to KEEP what the mint hands back once.
	//    Checking after the mint would strand an account whose only credential
	//    has already been shown and discarded.
	const mint = mintConfig(env);
	if (!mint) {
		return {
			ok: false,
			error:
				'Group creation is unavailable on this deployment: the group PDS is not configured. An administrator needs to set GROUP_PDS_SERVICE, GROUP_HANDLE_DOMAIN, GROUP_PDS_INVITE_CODE and GROUP_ACCOUNT_EMAIL.'
		};
	}
	if (!(await canStoreMintedCredentials(env))) {
		return {
			ok: false,
			error:
				'Group creation is unavailable on this deployment: there is nowhere to keep the new group’s credential. An administrator needs to set GROUP_CREDENTIAL_KEY.'
		};
	}

	let minted;
	try {
		minted = await mintGroupAccount(mint, data.slug);
	} catch (e) {
		if (e instanceof GroupMintError) return { ok: false, error: mintErrorMessage(e, data.slug) };
		throw e;
	}

	// The app password was shown exactly once, so it is stored BEFORE the group
	// row: a failure here leaves an orphan did:plc, and a failure after it would
	// leave one we can never write as again.
	try {
		await storeGroupCredential(env, env.DB, minted.did, minted.credential);
	} catch (e) {
		if (e instanceof GroupCredentialKeyError) {
			return {
				ok: false,
				error: `${minted.handle} was registered, but its credential could not be stored (${e.message}), so the group was not created. An administrator must fix GROUP_CREDENTIAL_KEY.`
			};
		}
		throw e;
	}

	let group;
	try {
		group = await createGroup(env.DB, {
			groupDid: minted.did,
			ownerDid: callerDid,
			name: data.name,
			// From the MINTED handle's leaf, never from the submitted field — the
			// PDS is what adjudicated the name, so its answer is the slug.
			slug: minted.handle.split('.')[0],
			description: data.description || null,
			status: data.status,
			visibility: data.visibility,
			requireApproval: data.requireApproval,
			locationName: data.locationName || null,
			locationAddress: data.locationAddress || null,
			locationTimezone: data.locationTimezone || null
		});
	} catch (e) {
		return formError(e);
	}

	// Provisioning is not ordered by the slug: the space key is `self`, so both
	// URIs are a function of the group DID alone.
	try {
		const uris = await provisionGroupSpaces(pdsProvisioner(minted.credential, minted.did));
		await recordGroupSpaces(env.DB, group.id, uris);
	} catch (e) {
		// The group EXISTS at this point, so saying "creation failed" would be a
		// lie. Name what is missing instead: `provisionGroupSpaces` is idempotent
		// (SpaceAlreadyExists resolves to the deterministic URI).
		const detail = e instanceof GroupSpaceError ? e.message : String(e);
		return {
			ok: false,
			error: `${group.slug} was created, but its spaces were not provisioned: ${detail}`
		};
	}

	// The owner's rotation key is shown exactly once and is the only thing that
	// lets them move this group off our PDS (FR-001g), so the caller must not
	// redirect: a 303 would destroy it.
	return { ok: true, groupSlug: group.slug, recoveryKey: minted.ownerRotationSecret };
}

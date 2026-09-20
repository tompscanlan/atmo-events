// GROUP CREATION, as a plain function.
//
// The body lives here rather than in `groups.remote.ts` for the reason
// `$lib/contrail/events-load-more.ts` names: the Vite plugin rejects non-remote
// exports from `*.remote.ts`, so a handler that only exists inside `form()`
// cannot be called by a test. `createGroupForm` is the thin wrapper that
// supplies `locals.did` and `platform.env`; everything that can go wrong lives
// here, where it is assertable.
//
// THE ORDER IS THE POINT. A did:plc is permanent and
// unrecallable, so the sequence is:
//
//   refuse -> refuse -> mint -> store -> INSERT -> provision
//
// Both refusals come BEFORE the mint: a label the PDS would reject, and a
// deployment that could not keep the credential the mint hands back exactly
// once. The handle registration is itself the name reservation, so a duplicate
// name fails at the mint and leaves nothing behind — no DID, no row, no space.
// (Spec: FR-001a for the reservation, SC-008 for the zero-artifact outcome.)
import type { CredentialStoreEnv } from './server/credentials';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	storeGroupCredential
} from './server/credentials';
import { GroupMintError, mintGroupAccount, type MintConfig, type MintFailure } from './server/mint';
import { createGroup, recordGroupSpaces } from './server/repo';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './server/members-writer';
import { pdsWriter } from './server/event-writer';
import { splitRuleLines } from './about-record';
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
	/** One rule per non-empty line. Rules have no column — the records in the
	 *  about space are the only copy. (Spec: FR-004c.) */
	rules?: string;
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
 *  "not you, and not your fault" WITHOUT guessing a cause: the create path is
 *  not allowed to call `com.atproto.admin.getInviteCodes` — a public Worker
 *  holding an admin password could take down any account on the host — and the
 *  PDS gives exhausted, wrong and rotated codes one identical error, so an
 *  unavailable code is genuinely ambiguous and claiming either cause would be a
 *  fabrication. Out-of-band detection is `om-pl5pw`. (Spec: FR-001e.) */
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
			// holding the first PLC rotation key, i.e. portable in name only, and
			// nothing should be presented as theirs on that footing. (Spec: FR-001g.)
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
	//    are wider than its handle rules (3-18 characters, no dot, not reserved),
	//    and the handle registration is itself the name reservation, so a label we
	//    could not mint must fail on the field the user can edit. (Spec: FR-001a.)
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
	let aboutUri: string;
	let membersUri: string;
	try {
		const uris = await provisionGroupSpaces(pdsProvisioner(minted.credential, minted.did));
		await recordGroupSpaces(env.DB, group.id, uris);
		aboutUri = uris.aboutSpaceUri;
		membersUri = uris.membersSpaceUri;
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

	// THE GROUP'S PUBLIC FACE, as records. Last, because it is the only step
	// whose failure leaves nothing broken: the group exists, its columns hold
	// everything the page needs, and the records can be written again by saving
	// the settings form. Ordering it before the INSERT is impossible anyway —
	// `requireGroupPermission` reads the owner's membership, which the INSERT
	// creates. (Spec: FR-004.)
	//
	// The credential we already hold, NOT `groupWriter` — that would decrypt the
	// row we wrote three statements ago to obtain the value still in scope. Same
	// transport either way; this one has fewer moving parts.
	const withSpaces = { ...group, about_space_uri: aboutUri, members_space_uri: membersUri };
	const writer = pdsWriter(minted.credential, minted.did);
	try {
		await writeGroupProfile({
			db: env.DB,
			env,
			group: withSpaces,
			callerDid,
			writer,
			profile: {
				name: data.name,
				description: data.description || null,
				locationName: data.locationName || null
			}
		});
		const rules = splitRuleLines(data.rules);
		if (rules.length > 0) {
			await setGroupRules({
				db: env.DB,
				env,
				group: withSpaces,
				callerDid,
				writer,
				desired: rules,
				// A group one statement old has no rule records, so the reconcile
				// starts from empty rather than paying a read to learn that.
				existing: []
			});
		}

		// AND THE ONE RECORD THE ANONYMOUS WEB CAN READ. Last of the public
		// face, because it is a POINTER at the about space: declaring a group
		// whose profile write just failed would announce a group to the network
		// and then hand the peer a space with nothing in it.
		//
		// A private group is not declared at all, and `assumeAbsent` says why
		// the withdrawal half is skipped here: a repo minted four statements ago
		// cannot be holding a declaration to withdraw. (Spec: FR-003.)
		await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group: withSpaces,
			callerDid,
			writer,
			assumeAbsent: true
		});
	} catch (e) {
		return {
			ok: false,
			error: `${group.slug} was created, but its profile records were not written: ${
				e instanceof Error ? e.message : String(e)
			}. Saving the group's settings will write them.`
		};
	}

	// THE CONTROL PLANE, as records: the members space's `access` record, the
	// group's authz config — one `role` per seeded role plus the two binding
	// records — and the ONE membership a new group has, the owner's. After this
	// the roster and the authz config are records with a D1 projection rather
	// than rows with a record copy, which is what lets `rebuildGroupMembers`
	// restore the roster from the space and lets a peer app read the group's
	// permissions without our database. (Spec: FR-005, FR-005a, FR-006;
	// `data-model.md`.)
	//
	// AUTHZ BEFORE THE MEMBERSHIP, because that is the order they resolve in: a
	// membership grants a role, a role means nothing until a `role` record
	// declares it and a binding says what it may do. A reader catching the
	// space mid-write then sees a config with no members rather than a member
	// holding a role nothing defines.
	//
	// Its own step, and its failure is reported separately, because the repair
	// path is NOT the settings form: saving settings rewrites the profile and
	// the rules, nothing roster- or authz-shaped. A group left here works —
	// every reader falls back to the cache while the members space holds no
	// membership record (`server/members-read.ts`) — so the honest report is
	// what is missing, not an instruction that would not fix it.
	try {
		await writeGroupAccess({ db: env.DB, env, group: withSpaces, callerDid, writer });
		await writeGroupAuthz({ db: env.DB, env, group: withSpaces, callerDid, writer });
		await putGroupMembership({
			db: env.DB,
			env,
			group: withSpaces,
			callerDid,
			writer,
			subject: callerDid,
			roles: ['owner'],
			intent: 'admit'
		});
	} catch (e) {
		return {
			ok: false,
			error: `${group.slug} was created, but its members-space records were not written: ${
				e instanceof Error ? e.message : String(e)
			}. The group works and its roster reads from the database; the members space stays empty until a member's role changes.`
		};
	}

	// The owner's rotation key is shown exactly once, is stored nowhere on our
	// side, and is the only thing that lets them move this group off our PDS — so
	// the caller must not redirect: a 303 would destroy it. (Spec: FR-001g.)
	return { ok: true, groupSlug: group.slug, recoveryKey: minted.ownerRotationSecret };
}

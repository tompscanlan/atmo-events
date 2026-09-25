// Group creation, as a plain function.
//
// It lives here rather than in `groups.remote.ts` because the Vite plugin
// rejects non-remote exports from `*.remote.ts`, so a handler that only exists
// inside `form()` cannot be called by a test. `createGroupForm` is the thin
// wrapper that supplies `locals.did` and `platform.env`.
//
// THE ORDER MATTERS. A did:plc is permanent, so the sequence is:
//
//   refuse -> refuse -> rehearse -> mint -> store -> INSERT -> provision
//
// Every refusal comes before the mint: a label the PDS would reject, a
// deployment that could not keep the credential the mint returns only once, and
// a row the groups tables would refuse. The INSERT is rehearsed and rolled
// back, so an INSERT that fails after the mint means the database changed or
// failed in between. Registering the handle is the name reservation, so a
// duplicate name fails at the mint and leaves nothing behind: no DID, no row,
// no space.
import type { CredentialStoreEnv } from './server/credentials';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	storeGroupCredential
} from './server/credentials';
import { GroupMintError, mintGroupAccount, type MintConfig, type MintFailure } from './server/mint';
import {
	GroupRuleError,
	createGroup,
	recordGroupSpaces,
	rehearseCreateGroup,
	type CreateGroupInput
} from './server/repo';
import { GroupSpaceError, pdsProvisioner, provisionGroupSpaces } from './server/spaces';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './server/members-writer';
import { pdsWriter } from './server/event-writer';
import { registerGroupIdentity } from './server/events-index';
import { splitRuleLines } from './about-record';
import { labelMintRefusal, labelMintRefusalMessage } from './handle-label';
import { formError } from './form-error';
import type { GroupFormResult } from './form-result';
import type { GroupVisibility } from './types';

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
	/** The handle label to mint under `GROUP_HANDLE_DOMAIN`. Not stored: the
	 *  handle the mint returns is the group's name reservation, and it is read
	 *  back through the identity resolver rather than copied into a column. */
	label: string;
	description?: string;
	visibility: GroupVisibility;
	/** The create form always supplies this: `checkboxField` parses an unticked
	 *  box as `false`, not as missing. It stays optional for callers that build
	 *  this object directly, and for them a missing value still means approval
	 *  on, because `repo.ts` stores anything but `false` as 1. */
	requireApproval?: boolean;
	locationName?: string;
	/** One rule per non-empty line. Rules have no column: the records in the
	 *  about space are the only copy. */
	rules?: string;
}

/** What a successful create hands back: the DID every URL will carry, the
 *  handle the PDS registered, and the rotation key shown exactly once. */
export type CreateGroupOutcome = GroupFormResult<{
	groupDid: string;
	handle: string;
	recoveryKey: string;
}>;

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

/** What a failed mint says to the person filling in the form.
 *
 *  The user's cases name the field they can change. The operator's cases say
 *  the problem is not the user's, without guessing a cause. The create path
 *  must not call `com.atproto.admin.getInviteCodes` (a public Worker holding an
 *  admin password could take down any account on the host), and the PDS returns
 *  the same error for exhausted, wrong and rotated codes, so the cause of an
 *  unavailable code cannot be known here. */
export function mintErrorMessage(
	e: { failure: MintFailure; message: string },
	label: string
): string {
	const operatorAlert = `Group creation is temporarily unavailable. This is a deployment problem, not something you did — please try again later or tell an administrator. (${e.failure})`;
	switch (e.failure) {
		case 'handle-taken':
			return `“${label}” is already taken. Choose another address for the group.`;
		case 'handle-invalid':
			return `The group PDS refused “${label}” as an address. Choose another one.`;
		case 'rotation-key-unverified':
			// Not swallowed: the group would exist without the owner holding the
			// first PLC rotation key, so it would be portable in name only, and it
			// must not be presented as theirs.
			return `“${label}” was registered, but we could not confirm that you hold its recovery key, so it has not been set up as your group. Tell an administrator before creating it again. (${e.message})`;
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
	// Refuse before minting, in three ways, because a did:plc is permanent.
	//
	// 1. The label must be one the PDS will accept as a handle. What this app
	//    accepts in a form is wider than the PDS's handle rules (3-18
	//    characters, no dot, not reserved), and the handle registration is
	//    itself the name reservation, so a label we could not mint must fail on
	//    the field the user can edit.
	const refusal = labelMintRefusal(data.label);
	if (refusal) return { ok: false, error: labelMintRefusalMessage(refusal, data.label) };

	// 2. The deployment must be able to keep what the mint hands back once.
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

	// The row stores no handle: the PDS decided it, the row keeps the DID, and
	// the identity resolver reads the handle back. One value serves both the
	// rehearsal and the INSERT, so they cannot disagree.
	const row: Omit<CreateGroupInput, 'groupDid'> = {
		ownerDid: callerDid,
		name: data.name,
		description: data.description || null,
		visibility: data.visibility,
		requireApproval: data.requireApproval,
		locationName: data.locationName || null
	};

	// 3. The groups tables must accept the row. Two things can refuse the
	//    INSERT: schema drift, and the trigger in migrations/0001_groups.sql
	//    that refuses a private group with approval off, which the create form
	//    can send. Rehearsing the INSERT asks the schema itself, so the rule is
	//    defined in one place.
	try {
		await rehearseCreateGroup(env.DB, row);
	} catch (e) {
		if (e instanceof GroupRuleError && e.reason === 'private-needs-approval') {
			return { ok: false, error: e.message };
		}
		// Nothing else the form sends can trip the schema, so the rest is the
		// deployment's: drift, or a database that did not answer.
		return {
			ok: false,
			error: `Group creation is unavailable on this deployment: the database would not accept the new group (${
				e instanceof Error ? e.message : String(e)
			}), so nothing was registered. Please tell an administrator.`
		};
	}

	let minted;
	try {
		minted = await mintGroupAccount(mint, data.label);
	} catch (e) {
		if (e instanceof GroupMintError) return { ok: false, error: mintErrorMessage(e, data.label) };
		throw e;
	}

	// The app password was shown exactly once, so it is stored before the group
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
		group = await createGroup(env.DB, { ...row, groupDid: minted.did });
	} catch (e) {
		return formError(e);
	}

	// Tell the indexer this account exists, before anything is written to it.
	// Contrail resolves a repo's PDS from its `identities` table first, and both
	// the write-time notification and the on-demand backfill need that to fetch
	// the group's events at all. The facts come from the mint rather than a
	// read-back, so this is one statement and no round trip.
	//
	// Not in a try/catch: the helper reports failure instead of throwing,
	// because a group whose index row did not land only gets its events late;
	// it has not failed to be created.
	await registerGroupIdentity(env.DB, {
		did: minted.did,
		handle: minted.handle,
		pds: mint.service
	});

	// Provisioning is not ordered by any name: the space key is `self`, so both
	// URIs are a function of the group DID alone.
	let aboutUri: string;
	let membersUri: string;
	try {
		const uris = await provisionGroupSpaces(pdsProvisioner(minted.credential, minted.did));
		await recordGroupSpaces(env.DB, group.id, uris);
		aboutUri = uris.aboutSpaceUri;
		membersUri = uris.membersSpaceUri;
	} catch (e) {
		// The group exists at this point, so the message names what is missing
		// rather than saying creation failed. `provisionGroupSpaces` is idempotent
		// (SpaceAlreadyExists resolves to the deterministic URI).
		const detail = e instanceof GroupSpaceError ? e.message : String(e);
		return {
			ok: false,
			error: `${minted.handle} was created, but its spaces were not provisioned: ${detail}`
		};
	}

	// The group's public face, as records. After the INSERT and the spaces,
	// because a failure here leaves nothing broken: the group exists, its
	// columns hold everything the page needs, and saving the settings form
	// writes the records again. It cannot come before the INSERT anyway:
	// `requireGroupPermission` reads the owner's membership, which the INSERT
	// creates.
	//
	// The writer uses the credential we already hold, not `groupWriter`, which
	// would decrypt the row we just wrote to get a value that is still in scope.
	// The transport is the same either way.
	const withSpaces = { ...group, about_space_uri: aboutUri, members_space_uri: membersUri };
	// One instant for every record a create writes: the row's own. Left to
	// themselves the profile, the declaration and the owner's membership each
	// stamp a later "now", and a rebuild that restores the row from them moves
	// the group's creation date by however long the create took.
	const createdAt = new Date(group.created_at).toISOString();
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
				locationName: data.locationName || null,
				createdAt
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

		// The declaration, the only record create writes to the public repo.
		// Last of the public face, because it points at the about space:
		// declaring a group whose profile write just failed would announce the
		// group to the network and then hand a peer an empty space.
		//
		// A private group is not declared at all. `assumeAbsent` skips the
		// withdrawal check, because a newly minted repo cannot hold a
		// declaration to withdraw.
		await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group: withSpaces,
			callerDid,
			writer,
			createdAt,
			assumeAbsent: true
		});
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but its profile records were not written: ${
				e instanceof Error ? e.message : String(e)
			}. Saving the group's settings will write them.`
		};
	}

	// The members space, as records: the `access` record, the owner's membership
	// (the only one a new group has), and the authz config (one `role` per
	// seeded role plus the two binding records). After this the roster and the
	// authz config are records with a D1 copy, not rows with a record copy.
	// That lets `rebuildGroupMembers` restore the roster from the space, and
	// lets a peer app read the group's permissions without our database.
	//
	// The owner's membership comes before the authz config, because the gate
	// resolves from these records. Once a config exists, a DID with no
	// membership record holds nothing, so writing the config first would lock
	// the owner out of admitting themselves. While no config exists the gate
	// falls back to the rows, where the owner holds every permission, so this
	// order passes the gate with no bypass. The cost: a reader who catches the
	// space mid-write sees a member whose role no record declares yet, and that
	// also resolves from the rows.
	//
	// This is its own step with its own error, because a settings save does not
	// repair it: that rewrites only the profile and the rules. A group left here
	// still works, since every reader falls back to the D1 rows while the
	// members space holds no membership record (`server/members-read.ts`). The
	// repair is "Repair this group" in the settings (`server/repair.ts`), which
	// writes these records when they are missing, so the error names it.
	try {
		await writeGroupAccess({ db: env.DB, env, group: withSpaces, callerDid, writer, createdAt });
		await putGroupMembership({
			db: env.DB,
			env,
			group: withSpaces,
			callerDid,
			writer,
			subject: callerDid,
			roles: ['owner'],
			intent: 'admit',
			createdAt
		});
		await writeGroupAuthz({ db: env.DB, env, group: withSpaces, callerDid, writer, createdAt });
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but its members-space records were not written: ${
				e instanceof Error ? e.message : String(e)
			}. The group works and its roster reads from this site's database; "Repair this group" in its settings writes the missing records.`
		};
	}

	// The owner's rotation key is shown exactly once, is stored nowhere on our
	// side, and is the only thing that lets them move this group off our PDS. So
	// the caller must not redirect: a 303 would lose it.
	return {
		ok: true,
		groupDid: group.group_did,
		handle: minted.handle,
		recoveryKey: minted.ownerRotationSecret
	};
}

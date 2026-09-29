// Group creation, as a plain function so a test can call it. `createGroupForm`
// in groups.remote.ts is the thin wrapper.
//
// A did:plc is permanent, so every refusal comes before the mint:
//
//   refuse -> rehearse the INSERT -> mint -> store -> INSERT -> provision
//
// The handle registration is the name reservation, so a taken name fails at
// the mint and leaves nothing behind.
import type { CredentialStoreEnv } from './server/credentials';
import {
	GroupCredentialKeyError,
	canStoreMintedCredentials,
	storeGroupCredential
} from './server/credentials';
import {
	GroupMintError,
	mintGroupAccount,
	type MintConfig,
	type MintFailure,
	type MintedGroup
} from './server/mint';
import {
	createGroup,
	recordGroupSpaces,
	rehearseCreateGroup,
	type CreateGroupInput
} from './server/repo';
import {
	GroupSpaceError,
	SpacesUnsupportedError,
	pdsProvisioner,
	provisionGroupSpaces
} from './server/spaces';
import { setGroupRules, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { putGroupMembership, writeGroupAccess, writeGroupAuthz } from './server/members-writer';
import { pdsWriter } from './server/event-writer';
import { pdsMemberList, putAboutMember } from './server/member-list';
import { registerGroupIdentity } from './server/events-index';
import { approvalRefusal, splitRuleLines } from './about-record';
import { labelMintRefusal, labelMintRefusalMessage } from './handle-label';
import { formError } from './form-error';
import type { GroupFormFailure, GroupFormResult, GroupFormSuccess } from './form-result';
import type { GroupVisibility } from './types';

/** Structural rather than `App.Platform['env']`, so a test can supply only
 *  what a create reads. */
export interface CreateGroupEnv extends CredentialStoreEnv {
	DB: D1Database;
	GROUP_PDS_SERVICE?: string;
	GROUP_HANDLE_DOMAIN?: string;
	GROUP_PDS_INVITE_CODE?: string;
	GROUP_ACCOUNT_EMAIL?: string;
}

export interface CreateGroupData {
	name: string;
	/** The handle label, minted under `GROUP_HANDLE_DOMAIN`. Never stored. */
	label: string;
	description?: string;
	visibility: GroupVisibility;
	/** Missing means approval on: `repo.ts` stores anything but `false` as 1. */
	requireApproval?: boolean;
	locationName?: string;
	/** One rule per non-empty line. Stored only as about-space records. */
	rules?: string;
}

/** The account a create registered. `recoveryKey` is the owner's rotation key,
 *  and this response holds its only copy. */
export interface RegisteredGroup {
	groupDid: string;
	handle: string;
	recoveryKey: string;
}

/** A create that fails after the mint still returns `registered`, so the
 *  owner's key is not lost with the error. */
export type CreateGroupOutcome = GroupFormResult<RegisteredGroup> | AfterMintFailure;

type AfterMintFailure = GroupFormFailure & { registered: RegisteredGroup };

/** The mint target, or null unless all four values are set. A partial
 *  configuration must fail before the mint, not after a did:plc exists. */
export function mintConfig(env: CreateGroupEnv): MintConfig | null {
	const service = env.GROUP_PDS_SERVICE?.trim();
	const handleDomain = env.GROUP_HANDLE_DOMAIN?.trim();
	const inviteCode = env.GROUP_PDS_INVITE_CODE?.trim();
	const accountEmail = env.GROUP_ACCOUNT_EMAIL?.trim();
	if (!service || !handleDomain || !inviteCode || !accountEmail) return null;
	return { service, handleDomain, inviteCode, accountEmail };
}

/** What a failed mint says to the person filling in the form. The operator's
 *  cases do not guess a cause: the PDS returns the same error for an exhausted,
 *  wrong or rotated invite code, and a public Worker must not hold the admin
 *  password that `com.atproto.admin.getInviteCodes` needs. */
export function mintErrorMessage(
	e: { failure: MintFailure; message: string },
	label: string
): string {
	const operatorAlert = `Group creation is temporarily unavailable. This is a deployment problem, not something you did. Please try again later or tell an administrator. (${e.failure})`;
	switch (e.failure) {
		case 'handle-taken':
			return `“${label}” is already taken. Choose another address for the group.`;
		case 'handle-invalid':
			return `The group PDS refused “${label}” as an address. Choose another one.`;
		case 'rotation-key-unverified':
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
	// 1. A private group must require approval to join.
	const approval = approvalRefusal(data.visibility, data.requireApproval);
	if (approval) return { ok: false, error: approval };

	// 2. The label must be a handle the PDS will accept, so the refusal lands on
	//    the field the user can edit rather than at the mint.
	const refusal = labelMintRefusal(data.label);
	if (refusal) return { ok: false, error: labelMintRefusalMessage(refusal, data.label) };

	// 3. The deployment must be able to store the credential, which the mint
	//    returns only once.
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

	// One value serves the rehearsal and the INSERT, so they cannot disagree.
	const row: Omit<CreateGroupInput, 'groupDid'> = {
		ownerDid: callerDid,
		name: data.name,
		description: data.description || null,
		requireApproval: data.requireApproval,
		locationName: data.locationName || null
	};

	// 4. The groups tables must accept the row. Rehearsing the INSERT catches
	//    schema drift, which cannot be listed in advance.
	try {
		await rehearseCreateGroup(env.DB, row);
	} catch (e) {
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
		if (!(e instanceof GroupMintError)) throw e;
		// Deployment failures are logged for the operator: the failure class only,
		// never the invite code, the email or the PDS's message.
		if (e.failure !== 'handle-taken' && e.failure !== 'handle-invalid') {
			console.error({
				event: 'groups.mint-failed',
				failure: e.failure,
				registered: e.registered !== undefined
			});
		}
		const error = mintErrorMessage(e, data.label);
		// A mint that fails after the account exists still returns the owner's key.
		if (!e.registered) return { ok: false, error };
		const { did, handle, recoveryKey } = e.registered;
		// The address is registered now, so a plain "try again" would fail as taken.
		const registeredNote =
			e.failure === 'rotation-key-unverified'
				? ''
				: ` ${handle} was registered before this failed, so keep its recovery key and tell an administrator before using that name again.`;
		return {
			ok: false,
			error: `${error}${registeredNote}`,
			registered: { groupDid: did, handle, recoveryKey }
		};
	}

	// From here on every way out carries `registered`, a throw included: an error
	// page would lose the owner's only copy of the rotation key.
	const registered: RegisteredGroup = {
		groupDid: minted.did,
		handle: minted.handle,
		recoveryKey: minted.ownerRotationSecret
	};
	try {
		return await setUpMintedGroup(env, callerDid, data, mint, row, minted, registered);
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was registered, but setting it up failed (${
				e instanceof Error ? e.message : String(e)
			}). Keep its recovery key, and tell an administrator before creating it again.`,
			registered
		};
	}
}

/** Everything after the mint. Every failure it returns carries `registered`,
 *  and `runCreateGroup` adds it to anything this throws. */
async function setUpMintedGroup(
	env: CreateGroupEnv,
	callerDid: string,
	data: CreateGroupData,
	mint: MintConfig,
	row: Omit<CreateGroupInput, 'groupDid'>,
	minted: MintedGroup,
	registered: RegisteredGroup
): Promise<GroupFormSuccess<RegisteredGroup> | AfterMintFailure> {
	// The app password is returned only once, so it is stored before the row. A
	// row without it would be a group this app can never write as.
	try {
		await storeGroupCredential(env, env.DB, minted.did, minted.credential);
	} catch (e) {
		if (e instanceof GroupCredentialKeyError) {
			return {
				ok: false,
				error: `${minted.handle} was registered, but its credential could not be stored (${e.message}), so the group was not created. An administrator must fix GROUP_CREDENTIAL_KEY.`,
				registered
			};
		}
		throw e;
	}

	let group;
	try {
		group = await createGroup(env.DB, { ...row, groupDid: minted.did });
	} catch (e) {
		return { ...formError(e), registered };
	}

	// Tell the indexer about the account before anything is written to it:
	// contrail resolves a repo's PDS from its `identities` table. This does not
	// throw, because a missing index row only delays the group's events.
	await registerGroupIdentity(env.DB, {
		did: minted.did,
		handle: minted.handle,
		pds: mint.service
	});

	// The visibility becomes the about space's read policy, so a private group is
	// closed to strangers at the host from its first moment.
	let aboutUri: string;
	let membersUri: string;
	try {
		const uris = await provisionGroupSpaces(
			pdsProvisioner(minted.credential, minted.did),
			data.visibility
		);
		await recordGroupSpaces(env.DB, group.id, uris);
		aboutUri = uris.aboutSpaceUri;
		membersUri = uris.membersSpaceUri;
	} catch (e) {
		if (e instanceof SpacesUnsupportedError) {
			return {
				ok: false,
				error: `${minted.handle} was created, but the group PDS does not support Spaces, so the group cannot be set up there. An administrator needs to point GROUP_PDS_SERVICE at a PDS that serves com.atproto.simplespace.`,
				registered
			};
		}
		const detail = e instanceof GroupSpaceError ? e.message : String(e);
		return {
			ok: false,
			error: `${minted.handle} was created, but its spaces were not provisioned: ${detail}`,
			registered
		};
	}

	// The group's public face, as records. After the INSERT, because
	// `requireGroupPermission` reads the owner's membership row, and a failure
	// here leaves a working group that a settings save can finish. The writer
	// uses the credential in scope rather than decrypting the stored copy.
	const withSpaces = { ...group, about_space_uri: aboutUri, members_space_uri: membersUri };
	// Every record takes the row's creation instant, so a rebuild from the
	// records restores the same date.
	const createdAt = new Date(group.created_at).toISOString();
	const writer = pdsWriter(minted.credential, minted.did);
	try {
		await writeGroupProfile({
			db: env.DB,
			env,
			group: withSpaces,
			visibility: data.visibility,
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
				// A new group has no rule records, so no read is needed.
				existing: []
			});
		}

		// The declaration goes last, so a group whose profile write failed is
		// never announced with an empty about space. A private group is not
		// declared. `assumeAbsent` skips the withdrawal check: a new repo has none.
		await reconcileGroupDeclaration({
			db: env.DB,
			env,
			group: withSpaces,
			visibility: data.visibility,
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
			}. Saving the group's settings writes them. Then "Repair this group" in its settings writes the members-space records this create skipped.`,
			registered
		};
	}

	// The members space, as records. The owner's membership goes before the
	// authz config: once a config exists the gate resolves from records, and
	// until then it falls back to the rows, where the owner holds every
	// permission. A failure here leaves a working group that "Repair this group"
	// can finish (server/repair.ts).
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
			}. The group works and its roster reads from this site's database; "Repair this group" in its settings writes the missing records.`,
			registered
		};
	}

	// The owner onto the about space's member list, after their membership
	// record, as for every later member (server/roster.ts). A public group gets
	// it too, so a later switch to private needs no backfill.
	try {
		await putAboutMember(pdsMemberList(minted.credential, minted.did), withSpaces, callerDid);
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but you were not added to its member list at its PDS: ${
				e instanceof Error ? e.message : String(e)
			}. The group works on this site; "Repair this group" in its settings adds you.`,
			registered
		};
	}

	return { ok: true, ...registered };
}

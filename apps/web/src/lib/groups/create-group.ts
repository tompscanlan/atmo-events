// Group creation, as a plain function so a test can call it. `createGroupForm`
// in groups.remote.ts is the thin wrapper.
//
// A did:plc is permanent, so every refusal comes before the mint:
//
//   refuse -> rehearse the INSERT -> mint -> INSERT -> provision
//
// The handle registration is the name reservation, so a taken name fails at
// the mint and leaves nothing behind. The creator types the account's email and
// password, and nothing here keeps or logs either: the setup writes go through
// the session the mint returns, and later writes wait for the owner to link the
// group's account (./server/group-link.ts).

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
import { setGroupRules, writeAboutAccess, writeGroupProfile } from './server/about-writer';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import {
	putGroupMembership,
	writeGroupAccess,
	writeGroupAuthz,
	writeGroupSpaceIndex
} from './server/members-writer';

import { pdsSpaceReader } from './server/about-read';
import { listRosterMember, pdsMemberList } from './server/member-list';
import { registerGroupIdentity } from './server/events-index';
import { approvalRefusal, splitRuleLines } from './about-record';
import { labelMintRefusal, labelMintRefusalMessage } from './handle-label';
import { formError } from './form-error';
import type { GroupFormFailure, GroupFormResult, GroupFormSuccess } from './form-result';
import type { GroupVisibility } from './types';
import { GROUP_PASSWORD_MIN_LENGTH } from './form-fields';

import { pdsWriter } from './server/group-write';
import { errorText } from './server/errors';
import { type CredentialStoreEnv } from './server/session';
/** Structural rather than `App.Platform['env']`, so a test can supply only
 *  what a create reads. */
export interface CreateGroupEnv extends CredentialStoreEnv {
	DB: D1Database;
	GROUP_PDS_SERVICE?: string;
	GROUP_HANDLE_DOMAIN?: string;
	GROUP_PDS_INVITE_CODE?: string;
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
	/** The group account's email, the creator's. Never stored. */
	email: string;
	/** The group account's password. Sent to the PDS once; never stored or logged. */
	password: string;
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

/** Added to a create failure that stopped before the calendar space's access
 *  record and index entry. Only a create writes them, so nothing later can
 *  finish them, and the remedy is a new group. (Spec: FR-101a.) */
const CALENDAR_NOT_REPAIRED =
	' "Repair this group" does not write the calendar space\'s access record or its entry in the space index, so for members-only events, create the group again with a new handle.';

/** The mint target, or null unless all three values are set. A partial
 *  configuration must fail before the mint, not after a did:plc exists. */
export function mintConfig(env: CreateGroupEnv): MintConfig | null {
	const service = env.GROUP_PDS_SERVICE?.trim();
	const handleDomain = env.GROUP_HANDLE_DOMAIN?.trim();
	const inviteCode = env.GROUP_PDS_INVITE_CODE?.trim();
	if (!service || !handleDomain || !inviteCode) return null;
	return { service, handleDomain, inviteCode };
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
		case 'email-rejected':
			return 'The group PDS would not take that email. Each account there needs its own address, so if you already used it, add a tag to your address (you+mygroup@example.com) or use another one.';
		case 'password-rejected':
			return 'The group PDS would not take that password. Choose a longer or different one.';
		case 'invite-missing':
		case 'invite-unavailable':
		case 'pds-unreachable':
			return operatorAlert;
	}
}

/** Refusals that are the creator's to fix, so not logged for the operator. */
const CREATOR_FAILURES: ReadonlySet<MintFailure> = new Set([
	'handle-taken',
	'handle-invalid',
	'email-rejected',
	'password-rejected'
]);

/** Why the typed login cannot be sent to the PDS, or null. Only a shape check:
 *  whether the PDS takes the address is known only when it answers. */
function loginRefusal(data: Pick<CreateGroupData, 'email' | 'password'>): string | null {
	const at = data.email.lastIndexOf('@');
	if (at <= 0 || at === data.email.length - 1 || /\s/.test(data.email)) {
		return 'Enter the email the group account should use. Password reset mail for the group goes there.';
	}
	if (data.password.length < GROUP_PASSWORD_MIN_LENGTH) {
		return `The group account's password needs at least ${GROUP_PASSWORD_MIN_LENGTH} characters.`;
	}
	return null;
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

	// 3. The account's login must be one the PDS can take, so the refusal lands on
	//    the fields rather than after a did:plc exists.
	const login = loginRefusal(data);
	if (login) return { ok: false, error: login };

	// 4. The deployment must be able to mint.
	const mint = mintConfig(env);
	if (!mint) {
		return {
			ok: false,
			error:
				'Group creation is unavailable on this deployment: the group PDS is not configured. An administrator needs to set GROUP_PDS_SERVICE, GROUP_HANDLE_DOMAIN and GROUP_PDS_INVITE_CODE.'
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

	// 5. The groups tables must accept the row. Rehearsing the INSERT catches
	//    schema drift, which cannot be listed in advance.
	try {
		await rehearseCreateGroup(env.DB, row);
	} catch (e) {
		return {
			ok: false,
			error: `Group creation is unavailable on this deployment: the database would not accept the new group (${errorText(
				e
			)}), so nothing was registered. Please tell an administrator.`
		};
	}

	let minted;
	try {
		minted = await mintGroupAccount(mint, data.label, {
			email: data.email,
			password: data.password
		});
	} catch (e) {
		if (!(e instanceof GroupMintError)) throw e;
		// Deployment failures are logged for the operator: the failure class only,
		// never the invite code, the login or the PDS's message.
		if (!CREATOR_FAILURES.has(e.failure)) {
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
			error: `${minted.handle} was registered, but setting it up failed (${errorText(
				e
			)}). Keep its recovery key, and tell an administrator before creating it again.`,
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
	// Every write below goes through the session the mint returned. None is kept:
	// after this request the group writes only through a session its owner links.
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
	// closed to strangers at the host from its first moment. The calendar space's
	// URI is not recorded: it follows from the DID. (Spec: FR-101a.)
	let aboutUri: string;
	let membersUri: string;
	let calendarUri: string;
	try {
		const uris = await provisionGroupSpaces(
			pdsProvisioner(minted.credential, minted.did),
			data.visibility
		);
		await recordGroupSpaces(env.DB, group.id, uris);
		aboutUri = uris.aboutSpaceUri;
		membersUri = uris.membersSpaceUri;
		calendarUri = uris.calendarSpaceUri;
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
	// here leaves a working group that a settings save can finish once linked.
	const withSpaces = { ...group, about_space_uri: aboutUri, members_space_uri: membersUri };
	// Every dated record takes the row's creation instant, so a rebuild from the
	// records restores the same date.
	const createdAt = new Date(group.created_at).toISOString();
	const writer = pdsWriter(minted.credential, minted.did);
	// The gate reads the members space too. The group is not linked yet, so it
	// reads with the same session; left to find its own, it would find none.
	const reader = pdsSpaceReader(minted.credential, minted.did);
	// What every write below shares: the group as provisioned, the caller, and
	// the minted session's writer and reader.
	const as = { db: env.DB, env, group: withSpaces, callerDid, writer, reader };
	try {
		await writeGroupProfile({
			...as,
			visibility: data.visibility,
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
				...as,
				desired: rules,
				// A new group has no rule records, so no read is needed.
				existing: []
			});
		}

		// The about space's access record says what its read policy says. It goes
		// before the declaration, so a declared group's access always says public.
		await writeAboutAccess({
			...as,
			visibility: data.visibility
		});

		// The declaration goes last, so a group whose profile write failed is
		// never announced with an empty about space. A private group is not
		// declared. `assumeAbsent` skips the withdrawal check: a new repo has none.
		await reconcileGroupDeclaration({
			...as,
			visibility: data.visibility,
			createdAt,
			assumeAbsent: true
		});
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but its profile records were not written: ${errorText(
				e
			)}. Link the group's account from its page, then save its settings to write them, and run "Repair this group" in its settings for the members-space records and member lists this create skipped.${CALENDAR_NOT_REPAIRED}`,
			registered
		};
	}

	// The members space, as records. The owner's membership goes before the
	// authz config: once a config exists the gate resolves from records, and
	// until then it falls back to the rows, where the owner holds every
	// permission. The index of the spaces grants nothing, so it can go anywhere
	// before the config. A failure here leaves a working group that "Repair this
	// group" can finish (server/repair.ts), except for the calendar space's two
	// records, which repair leaves alone, so the message says so when they are
	// missing.
	//
	// The calendar space gets its access record and its index entry here, and
	// only here: repair does not pass it. Its member list stays empty, since the
	// app reads it as the group. (Spec: FR-101b.)
	let calendarWritten = false;
	try {
		await writeGroupAccess(as);
		await writeGroupAccess({
			...as,
			space: calendarUri
		});
		// A new members space holds no index, so nothing is read.
		await writeGroupSpaceIndex({
			...as,
			existing: [],
			calendarSpace: calendarUri,
			createdAt
		});
		calendarWritten = true;
		await putGroupMembership({
			...as,
			subject: callerDid,
			roles: ['owner'],
			intent: 'admit',
			createdAt
		});
		await writeGroupAuthz({
			...as,
			createdAt
		});
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but not all of its member and calendar records were written: ${errorText(
				e
			)}. Link the group's account from its page, then "Repair this group" in its settings writes the missing members-space records.${
				calendarWritten ? '' : CALENDAR_NOT_REPAIRED
			}`,
			registered
		};
	}

	// The owner onto both member lists, after their membership record, as for
	// every later member (server/roster.ts). A public group gets the about
	// space's entry too, so a later switch to private needs no backfill.
	try {
		await listRosterMember(pdsMemberList(minted.credential, minted.did), withSpaces, callerDid);
	} catch (e) {
		return {
			ok: false,
			error: `${minted.handle} was created, but you were not added to its member lists at its PDS: ${errorText(
				e
			)}. Link the group's account from its page, then "Repair this group" in its settings adds you.`,
			registered
		};
	}

	return { ok: true, ...registered };
}

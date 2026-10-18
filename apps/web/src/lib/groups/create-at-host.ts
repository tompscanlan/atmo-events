// Group creation at a group host (`GROUP_HOST_URL`), the standard's way: the app
// starts its OAuth flow at the host with `prompt=create`, the host signs the
// creator in through their own PDS, makes the group's account, its meta and
// members spaces and their records (the `admin` and `member` roles, `permissions`,
// the creator's `admin` membership), and hands this app a group session the
// creator approved (proposal.md, "Creating a group"). No login, no recovery key and
// no member list passes through here: the host keeps all three.
//
//   refuse -> rehearse the INSERT -> sign up at the host -> (callback) checks
//          -> INSERT -> calendar space -> this app's records
//
// What this app adds is its own: the row, the calendar space (made through the
// host, its `access` naming the host's roles), the event bindings for those roles,
// the profile and rules as the form gave them, the meta space's `public`, and the
// declaration of a public group. The creator's session is the one stored by the
// callback, filed under them like any link (./server/group-link.ts). A picture
// from the form waits in a stash (./server/avatar-stash.ts) until the group has a
// repo to upload it into.
import type { Did } from '@atcute/lexicons';
import type { OAuthClient, OAuthClientStores } from '@atcute/oauth-node-client';

import { approvalRefusal, groupAvatarRefusal, splitRuleLines } from './about-record';
import { knownFormError } from './form-error';
import type { GroupFormResult } from './form-result';
import { POLICY_MEMBER_LIST, SPACE_SKEY, groupSpaceUris } from './ids';
import { spaceReadScope } from './members-record';
import { DEFAULT_ROLE_PERMISSIONS } from './permissions';
import { CALENDAR_SPACE_TYPE, type GroupVisibility } from './types';

import { pdsSpaceReader, readAboutAccess } from './server/about-read';
import type { AvatarStash } from './server/avatar-stash';
import { setGroupRules, writeAboutAccess, writeGroupProfile } from './server/about-writer';
import {
	createGroup,
	getGroupByDid,
	recordGroupSpaces,
	rehearseCreateGroup,
	type CreateGroupInput
} from './server/db/groups';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { errorText } from './server/errors';
import { credentialBlobUploader } from './server/event-writer';
import { pdsWriter } from './server/group-write';
import { refreshGroupHandle } from './server/handles';
import { groupHostOrigin, isHostGroup } from './server/host-kind';
import { registerGroupIdentity } from './server/identities';
import { realGroupHost } from './server/real-host';
import { writeEventPermissions } from './server/members-writer';
import {
	groupLinkConfigured,
	groupSessionScope,
	type CredentialStoreEnv,
	type LinkedGroupCredential
} from './server/session';

/** What the create form gives a create at the host. The group's address is
 *  chosen at the host's own sign-up page, so there is no label, and the host
 *  holds the account, so there is no login. */
export interface HostCreateFields {
	name: string;
	description?: string;
	visibility: GroupVisibility;
	requireApproval?: boolean;
	locationName?: string;
	rules?: string;
}

/** Carried through the host in the authorization's state. */
export interface HostCreateState {
	create: HostCreateFields;
	/** The person who started the create, whose session the group's becomes. */
	by: string;
	/** The stash key of the form's picture, when it had one. */
	avatar?: string;
}

export interface HostCreateEnv extends CredentialStoreEnv {
	DB: D1Database;
}

/** The roles a group host declares at create (`admin`, `member`), with this app's
 *  default event bundles. */
const HOST_ROLE_BUNDLES = {
	admin: DEFAULT_ROLE_PERMISSIONS.admin,
	member: DEFAULT_ROLE_PERMISSIONS.member
};

/** The host's origin when this deployment creates groups there: it names a group
 *  host and can link what the host makes. Null otherwise. */
export function hostCreation(env: CredentialStoreEnv | undefined): string | null {
	return groupLinkConfigured(env) ? groupHostOrigin(env) : null;
}

type StartClient = Pick<OAuthClient, 'authorize'>;

/** The refusals a create can meet before anything exists at the host, then the
 *  host's sign-up URL. The INSERT is rehearsed first, so a schema the row would
 *  not fit fails here rather than after the host has made the group. */
export async function startCreateAtHost(input: {
	db: D1Database;
	client: StartClient;
	hostUrl: string;
	callerDid: string;
	fields: HostCreateFields;
	redirectUri: string;
	/** The group's picture, from the form, and where it waits meanwhile. */
	avatar?: { image: Blob; stash: AvatarStash };
}): Promise<GroupFormResult<{ signUpUrl: string }>> {
	const { fields } = input;
	const approval = approvalRefusal(fields.visibility, fields.requireApproval);
	if (approval) return { ok: false, error: approval };
	const pictureRefusal = input.avatar ? groupAvatarRefusal(input.avatar.image) : null;
	if (pictureRefusal) return { ok: false, error: pictureRefusal };
	try {
		await rehearseCreateGroup(input.db, rowFor(input.callerDid, fields));
	} catch (e) {
		return {
			ok: false,
			error: `Group creation is unavailable on this deployment: the database would not accept the new group (${errorText(
				e
			)}), so nothing was made. Please tell an administrator.`
		};
	}
	const state: HostCreateState = {
		create: hostFields(fields),
		by: input.callerDid,
		...(input.avatar ? { avatar: await input.avatar.stash.put(input.avatar.image) } : {})
	};
	const { url } = await input.client.authorize({
		target: { type: 'pds', serviceUrl: input.hostUrl },
		prompt: 'create',
		// The scope any link asks for. Admin's grants at a new group cover it all,
		// the calendar space included, which does not exist yet.
		scope: groupSessionScope(false),
		redirectUri: input.redirectUri,
		state
	});
	// Hints for the host's sign-up page, which asks for the group's address and
	// the creator's own handle: it suggests an address from the name and looks up
	// the person's handle, and both stay editable there. They go on the link the
	// browser opens, not in the request, whose unknown fields the PDS drops.
	const signUp = new URL(url);
	signUp.searchParams.set('gh_name', fields.name);
	signUp.searchParams.set('gh_person', input.callerDid);
	return { ok: true, signUpUrl: signUp.toString() };
}

function rowFor(ownerDid: string, fields: HostCreateFields): Omit<CreateGroupInput, 'groupDid'> {
	return {
		ownerDid,
		name: fields.name,
		description: fields.description || null,
		requireApproval: fields.requireApproval,
		locationName: fields.locationName || null
	};
}

/** Only the fields this module reads, so the state carries nothing else. */
function hostFields(fields: HostCreateFields): HostCreateFields {
	return {
		name: fields.name,
		visibility: fields.visibility,
		...(fields.description ? { description: fields.description } : {}),
		...(fields.requireApproval !== undefined ? { requireApproval: fields.requireApproval } : {}),
		...(fields.locationName ? { locationName: fields.locationName } : {}),
		...(fields.rules ? { rules: fields.rules } : {})
	};
}

function createState(value: unknown): HostCreateState | null {
	if (!value || typeof value !== 'object') return null;
	const { create, by, avatar } = value as Record<string, unknown>;
	if (typeof by !== 'string' || !by.startsWith('did:')) return null;
	if (!create || typeof create !== 'object') return null;
	const fields = create as Record<string, unknown>;
	if (typeof fields.name !== 'string' || !fields.name) return null;
	if (fields.visibility !== 'public' && fields.visibility !== 'private') return null;
	return {
		create: create as HostCreateFields,
		by,
		...(typeof avatar === 'string' && avatar ? { avatar } : {})
	};
}

export type HostCreateResult =
	| { ok: true; groupDid: string }
	/** `error` is for the person; `groupDid` is set once the host made the group. */
	| { ok: false; groupDid: string | null; error: string };

type FinishClient = Pick<OAuthClient, 'callback' | 'revoke'>;

/** Finishes a create at the callback: only the browser that started it, still
 *  signed in as that person, may finish it, checked before the code is
 *  exchanged; the account that comes back must live at the configured host and be
 *  new here. Then sets it up (`setUpHostGroup`). `clientFor` files the session
 *  under the person who started the create. */
export async function finishCreateAtHost(input: {
	env: HostCreateEnv;
	clientFor: (personDid: string) => FinishClient;
	states: Pick<OAuthClientStores['states'], 'get' | 'delete'>;
	params: URLSearchParams;
	signedInDid: string | null;
	/** Where the form's picture waited, if it had one. */
	stash?: AvatarStash;
}): Promise<HostCreateResult> {
	const stateId = input.params.get('state');
	const stored = stateId ? await input.states.get(stateId) : undefined;
	const started = stored ? createState(stored.userState) : null;
	if (!stateId || !started) {
		return { ok: false, groupDid: null, error: 'That sign-up is unknown or has expired.' };
	}
	if (input.signedInDid !== started.by) {
		// Single use, as the client's own callback would make it.
		await input.states.delete(stateId);
		return {
			ok: false,
			groupDid: null,
			error: 'This sign-up was started by someone else, or you have signed out since.'
		};
	}

	const client = input.clientFor(started.by);
	let session: LinkedGroupCredential['session'];
	try {
		({ session } = await client.callback(input.params));
	} catch (e) {
		// A cancelled sign-up, or a host that failed the exchange.
		return {
			ok: false,
			groupDid: null,
			error: `The group host did not finish the sign-up (${errorText(e)}).`
		};
	}
	const groupDid = session.did;
	const revoke = () =>
		client.revoke(groupDid as Did).catch((e) => {
			console.error(`[groups] revoking a create's session for ${groupDid} failed:`, e);
		});

	let atHost: boolean;
	try {
		atHost = await isHostGroup(input.env, groupDid);
	} catch (e) {
		atHost = false;
		console.error(`[groups] ${groupDid}: resolving a new group failed:`, e);
	}
	if (!atHost) {
		await revoke();
		return {
			ok: false,
			groupDid: null,
			error: `The account that came back (${groupDid}) does not live at this site's group host, so it was not set up as a group.`
		};
	}
	if (await getGroupByDid(input.env.DB, groupDid)) {
		return { ok: false, groupDid, error: `${groupDid} is already a group here.` };
	}

	const result = await setUpHostGroup(
		input.env,
		started.by,
		started.create,
		{ kind: 'linked', person: started.by, session },
		groupHostOrigin(input.env)!,
		await takeAvatar(input.stash, started.avatar, groupDid)
	);
	return result.ok ? { ok: true, groupDid } : { ok: false, groupDid, error: result.error };
}

/** The form's picture, or null. One that is gone (it outlived the sign-up, or
 *  the store failed) does not stop the create: the group is made without it,
 *  and a picture can be added from its settings. */
async function takeAvatar(
	stash: AvatarStash | undefined,
	key: string | undefined,
	groupDid: string
): Promise<Blob | null> {
	if (!key) return null;
	try {
		const image = stash ? await stash.take(key) : null;
		if (!image)
			console.error(`[groups] ${groupDid}: the create's picture was gone at the callback`);
		return image;
	} catch (e) {
		console.error(`[groups] ${groupDid}: reading the create's picture failed:`, e);
		return null;
	}
}

/**
 * Everything after the host made the group, on the creator's new session. The
 * gate runs as the group itself, as a mint's set-up does: these are the group's
 * own first writes, and the host checks the creator's roles on every one.
 * Every failure names the group, which exists at the host whatever happens here.
 */
export async function setUpHostGroup(
	env: HostCreateEnv,
	creatorDid: string,
	fields: HostCreateFields,
	credential: LinkedGroupCredential,
	hostOrigin: string,
	/** The group's picture, uploaded into its repo and named by its profile. */
	avatar: Blob | null = null
): Promise<GroupFormResult<{ groupDid: string }>> {
	const groupDid = credential.session.did;
	const made = (step: string, detail: string) => ({
		ok: false as const,
		error: `The group host made ${groupDid}, but ${step} failed (${detail}). Tell an administrator before creating it again.`
	});

	let group;
	try {
		group = await createGroup(env.DB, { ...rowFor(creatorDid, fields), groupDid });
	} catch (e) {
		return made('saving it on this site', knownFormError(e)?.error ?? errorText(e));
	}
	// Where its repo lives, before anything is written to it (the index resolves
	// the DID through this), then its handle, checked both ways, when the host
	// answers. Neither throws.
	await registerGroupIdentity(env.DB, { did: groupDid, handle: null, pds: hostOrigin });
	await refreshGroupHandle(env.DB, groupDid);

	// meta and members are the host's; the calendar space is this app's, made
	// through the host with its `access`, which names the host's roles. Admin
	// writes in it through the grant across every space the host gives it. The
	// group is known to be at the host, so its adapter is asked directly.
	const uris = groupSpaceUris(groupDid);
	try {
		await realGroupHost({ db: env.DB, env, group, credential }).createSpace(
			{ callerDid: groupDid },
			{
				type: CALENDAR_SPACE_TYPE,
				skey: SPACE_SKEY,
				readPolicy: POLICY_MEMBER_LIST,
				access: {
					public: false,
					grants: Object.keys(HOST_ROLE_BUNDLES).map((role) => ({
						role,
						scopes: [spaceReadScope(CALENDAR_SPACE_TYPE)]
					}))
				}
			}
		);
		await recordGroupSpaces(env.DB, group.id, uris);
	} catch (e) {
		return made('making its calendar space', errorText(e));
	}

	const withSpaces = {
		...group,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	const createdAt = new Date(group.created_at).toISOString();
	const reader = pdsSpaceReader(credential, groupDid);
	const as = {
		db: env.DB,
		env,
		group: withSpaces,
		callerDid: groupDid,
		writer: pdsWriter(credential, groupDid, { atHost: true }),
		reader
	};
	try {
		await writeEventPermissions({ ...as, bundles: HOST_ROLE_BUNDLES, createdAt });
		// Uploaded just before the profile that cites it, so the PDS keeps it.
		const avatarRef = avatar ? await credentialBlobUploader(credential, groupDid)(avatar) : null;
		await writeGroupProfile({
			...as,
			visibility: fields.visibility,
			profile: {
				name: fields.name,
				description: fields.description || null,
				locationName: fields.locationName || null,
				createdAt,
				avatar: avatarRef
			}
		});
		const rules = splitRuleLines(fields.rules);
		if (rules.length > 0) await setGroupRules({ ...as, desired: rules, existing: [] });
		// The host's own grants stay; only `public` follows the form. The host
		// reads the meta space's policy from it. Before the declaration, so a
		// declared group's access always says public. (Spec: FR-214.)
		const access = await readAboutAccess(reader, withSpaces);
		await writeAboutAccess({ ...as, visibility: fields.visibility, grants: access?.grants });
		await reconcileGroupDeclaration({
			...as,
			visibility: fields.visibility,
			createdAt,
			declared: false
		});
	} catch (e) {
		return made('writing its profile and settings', errorText(e));
	}
	return { ok: true, groupDid };
}

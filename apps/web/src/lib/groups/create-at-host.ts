// Group creation the proposal's way: the app starts its OAuth flow at the group host
// with `prompt=create`, and the host makes the group's account, its two spaces and their
// records, and hands back a group session the creator approved. What this app adds is
// its row and the form's records: the profile, the rules, the meta space's `public`,
// and the declaration of a listed public group.
//
//   sign up at the host -> (callback) checks -> INSERT -> records -> spaces recorded
//
// The row's spaces stay NULL until the last step, so a create that stopped partway is
// finished, not refused, when its creator's session comes back for the same group.
import type { Did } from '@atcute/lexicons';
import type { OAuthClient, OAuthClientStores } from '@atcute/oauth-node-client';
import { GROUP_JOIN_POLICIES, splitRuleLines, type GroupJoinPolicy } from './about-record';
import { knownFormError } from './form-error';
import type { GroupFormResult } from './form-result';
import { groupSpaceUris } from './ids';
import type { GroupRow, GroupVisibility } from './types';
import { pdsSpaceReader, readAboutAccess, readGroupAbout } from './server/about-read';
import { createGroupRules, writeAboutAccess, writeGroupProfile } from './server/about-writer';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/db/groups';
import { getMemberRow } from './server/db/roster';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { errorText } from './server/errors';
import { pdsWriter } from './server/group-write';
import { refreshGroupHandle } from './server/handles';
import { groupHostOrigin, isHostGroup } from './server/host';
import { registerGroupIdentity } from './server/identities';
import {
	groupLinkConfigured,
	groupSessionScope,
	type CredentialStoreEnv,
	type LinkedGroupCredential
} from './server/session';

export interface HostCreateFields {
	name: string;
	description?: string;
	visibility: GroupVisibility;
	joinPolicy: GroupJoinPolicy;
	listed: boolean;
	rules?: string;
}

/** Carried through the host in the authorization's state. */
export interface HostCreateState {
	create: HostCreateFields;
	/** Whose session the group's becomes. */
	by: string;
}

export interface HostCreateEnv extends CredentialStoreEnv {
	DB: D1Database;
}

/** The host's origin when this deployment can link what the host makes, else null. */
export function hostCreation(env: CredentialStoreEnv | undefined): string | null {
	return groupLinkConfigured(env) ? groupHostOrigin(env) : null;
}

export async function startCreateAtHost(input: {
	client: Pick<OAuthClient, 'authorize'>;
	hostUrl: string;
	callerDid: string;
	fields: HostCreateFields;
	redirectUri: string;
}): Promise<GroupFormResult<{ signUpUrl: string }>> {
	const { fields } = input;
	const state: HostCreateState = { create: hostFields(fields), by: input.callerDid };
	const { url } = await input.client.authorize({
		target: { type: 'pds', serviceUrl: input.hostUrl },
		prompt: 'create',
		scope: groupSessionScope(),
		redirectUri: input.redirectUri,
		state
	});
	// Hints for the host's sign-up page, on the link: the PDS drops unknown request fields.
	const signUp = new URL(url);
	signUp.searchParams.set('gh_name', fields.name);
	signUp.searchParams.set('gh_person', input.callerDid);
	return { ok: true, signUpUrl: signUp.toString() };
}

function hostFields(fields: HostCreateFields): HostCreateFields {
	return {
		name: fields.name,
		visibility: fields.visibility,
		joinPolicy: fields.joinPolicy,
		listed: fields.listed,
		...(fields.description ? { description: fields.description } : {}),
		...(fields.rules ? { rules: fields.rules } : {})
	};
}

function createState(value: unknown): HostCreateState | null {
	if (!value || typeof value !== 'object') return null;
	const { create, by } = value as Record<string, unknown>;
	if (typeof by !== 'string' || !by.startsWith('did:')) return null;
	if (!create || typeof create !== 'object') return null;
	const fields = create as Record<string, unknown>;
	if (typeof fields.name !== 'string' || !fields.name) return null;
	if (fields.visibility !== 'public' && fields.visibility !== 'private') return null;
	if (!(GROUP_JOIN_POLICIES as readonly unknown[]).includes(fields.joinPolicy)) return null;
	return { create: { ...(create as HostCreateFields), listed: fields.listed === true }, by };
}

export type HostCreateResult =
	| { ok: true; groupDid: string }
	/** `groupDid` is set once the host made the group. */
	| { ok: false; groupDid: string | null; error: string };

type FinishClient = Pick<OAuthClient, 'callback' | 'revoke'>;

/** Only the browser that started the create, still signed in as that person, may finish
 *  it, checked before the code is exchanged; the account that comes back must live at
 *  this site's host. */
export async function finishCreateAtHost(input: {
	env: HostCreateEnv;
	clientFor: (personDid: string) => FinishClient;
	states: Pick<OAuthClientStores['states'], 'get' | 'delete'>;
	params: URLSearchParams;
	signedInDid: string | null;
}): Promise<HostCreateResult> {
	const stateId = input.params.get('state');
	const stored = stateId ? await input.states.get(stateId) : undefined;
	const started = stored ? createState(stored.userState) : null;
	if (!stateId || !started) {
		return { ok: false, groupDid: null, error: 'That sign-up is unknown or has expired.' };
	}
	if (input.signedInDid !== started.by) {
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
		return {
			ok: false,
			groupDid: null,
			error: `The group host did not finish the sign-up (${errorText(e)}).`
		};
	}
	const groupDid = session.did;

	const atHost = await isHostGroup(input.env, groupDid).catch((e) => {
		console.error(`[groups] ${groupDid}: resolving a new group failed:`, e);
		return false;
	});
	if (!atHost) {
		await client.revoke(groupDid as Did).catch((e) => {
			console.error(`[groups] revoking a create's session for ${groupDid} failed:`, e);
		});
		return {
			ok: false,
			groupDid: null,
			error: `The account that came back (${groupDid}) does not live at this site's group host, so it was not set up as a group.`
		};
	}

	const existing = await getGroupByDid(input.env.DB, groupDid);
	const resumable =
		existing?.members_space_uri === null &&
		(await getMemberRow(input.env.DB, existing.id, started.by))?.role === 'admin';
	if (existing && !resumable) {
		return { ok: false, groupDid, error: `${groupDid} is already a group here.` };
	}

	const result = await setUpHostGroup(
		input.env,
		started.by,
		started.create,
		{ kind: 'linked', person: started.by, session },
		groupHostOrigin(input.env)!,
		existing
	);
	return result.ok ? { ok: true, groupDid } : { ok: false, groupDid, error: result.error };
}

/** Everything after the host made the group, on the creator's new session, as the group
 *  itself: the host checks the creator's roles on every write. */
export async function setUpHostGroup(
	env: HostCreateEnv,
	creatorDid: string,
	fields: HostCreateFields,
	credential: LinkedGroupCredential,
	hostOrigin: string,
	existing: GroupRow | null = null
): Promise<GroupFormResult<{ groupDid: string }>> {
	const groupDid = credential.session.did;
	const made = (step: string, detail: string) => ({
		ok: false as const,
		error: `The group host made ${groupDid}, but ${step} failed (${detail}). Tell an administrator before creating it again.`
	});

	let group = existing;
	if (!group) {
		try {
			group = await createGroup(env.DB, {
				groupDid,
				creatorDid,
				name: fields.name,
				description: fields.description || null
			});
		} catch (e) {
			return made('saving it on this site', knownFormError(e)?.error ?? errorText(e));
		}
	}
	// Where its repo lives, before anything is written to it, since the index resolves
	// the DID through this. Neither throws.
	await registerGroupIdentity(env.DB, { did: groupDid, handle: null, pds: hostOrigin });
	await refreshGroupHandle(env.DB, groupDid);

	const uris = groupSpaceUris(groupDid);
	const withSpaces = {
		...group,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	const reader = pdsSpaceReader(credential, groupDid);
	const as = {
		db: env.DB,
		env,
		group: withSpaces,
		callerDid: groupDid,
		writer: pdsWriter(credential, groupDid),
		reader
	};
	try {
		await writeGroupProfile({
			...as,
			profile: {
				name: fields.name,
				description: fields.description || null,
				joinPolicy: fields.joinPolicy
			}
		});
		if (!existing || (await readGroupAbout(reader, withSpaces)).rules.length === 0) {
			await createGroupRules({ ...as, rules: splitRuleLines(fields.rules) });
		}
		// Only `public` follows the form; the host's grants stay. Before the declaration,
		// so a declared group's access always says public.
		const access = await readAboutAccess(reader, withSpaces);
		await writeAboutAccess({ ...as, visibility: fields.visibility, grants: access?.grants });
		await reconcileGroupDeclaration({
			...as,
			visibility: fields.visibility,
			listed: fields.listed,
			declared: false
		});
		await recordGroupSpaces(env.DB, group.id, uris);
	} catch (e) {
		return made('writing its profile and settings', errorText(e));
	}
	return { ok: true, groupDid };
}

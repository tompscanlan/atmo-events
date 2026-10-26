// Creating a group: an OAuth flow at the group host with `prompt=create`, which makes the
// account and its spaces; then, on the creator's new group session:
//
//   (callback) checks -> INSERT -> calendar space -> profile, rules, access, declaration
//   -> spaces recorded
//
// The row's spaces stay NULL until the last step, and the form waits in KV until then, so
// the group page can offer its creator the rest of a create that stopped. The calendar
// space is atmo's own, for members-only events; every role may read it.
import type { Did } from '@atcute/lexicons';
import type { OAuthClient, OAuthClientStores } from '@atcute/oauth-node-client';
import { GROUP_JOIN_POLICIES, splitRuleLines, type GroupJoinPolicy } from './about-record';
import { knownFormError } from './form-error';
import type { GroupFormResult } from './form-result';
import { SPACE_SKEY, groupSpaceUris } from './ids';
import { spaceReadScope } from './members-record';
import { GROUP_ROLES } from './permissions';
import { CALENDAR_SPACE_TYPE, type GroupRow, type GroupVisibility } from './types';
import { pdsSpaceReader, readAboutAccess, readGroupAbout } from './server/about-read';
import { createGroupRules, writeAboutAccess, writeGroupProfile } from './server/about-writer';
import { createGroup, getGroupByDid, recordGroupSpaces } from './server/db/groups';
import { reconcileGroupDeclaration } from './server/declaration-writer';
import { errorText } from './server/errors';
import { pdsWriter } from './server/group-write';
import { refreshGroupHandle } from './server/handles';
import { groupActorToDid } from './server/route-context';
import { groupHostOrigin, hostMethods, isHostGroup } from './server/host';
import { registerGroupIdentity } from './server/identities';
import {
	groupLinkConfigured,
	groupSessionScope,
	resolveGroupCredential,
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

export interface HostCreateState {
	create: HostCreateFields;
	by: string;
}

export interface HostCreateEnv extends CredentialStoreEnv {
	DB: D1Database;
}

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
	| { ok: false; groupDid: string | null; error: string; unfinished?: true };

const PENDING_SETUP_PREFIX = 'group:setup:';

/** The form of a create whose setup has not finished, and who started it. */
export async function pendingSetup(
	env: CredentialStoreEnv | undefined,
	groupDid: string
): Promise<HostCreateState | null> {
	const kept = await env?.OAUTH_SESSIONS?.get(PENDING_SETUP_PREFIX + groupDid, 'json');
	return createState(kept);
}

async function keepPendingSetup(env: CredentialStoreEnv, groupDid: string, state: HostCreateState) {
	await env.OAUTH_SESSIONS?.put(PENDING_SETUP_PREFIX + groupDid, JSON.stringify(state));
}

async function dropPendingSetup(env: CredentialStoreEnv, groupDid: string) {
	await env.OAUTH_SESSIONS?.delete(PENDING_SETUP_PREFIX + groupDid);
}

type FinishClient = Pick<OAuthClient, 'callback' | 'revoke'>;

/** Only the browser that started the create, still signed in as that person, may finish it. */
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

	if (await getGroupByDid(input.env.DB, groupDid)) {
		return { ok: false, groupDid, error: `${groupDid} is already a group here.` };
	}

	await keepPendingSetup(input.env, groupDid, started);
	const result = await setUpHostGroup(
		input.env,
		started.by,
		started.create,
		{ kind: 'linked', person: started.by, session },
		groupHostOrigin(input.env)!
	);
	if (!result.ok) return { ok: false, groupDid, error: result.error, unfinished: true };
	await dropPendingSetup(input.env, groupDid);
	return { ok: true, groupDid };
}

/** For the group page, which is otherwise a 404 until the group's spaces are recorded. */
export async function unfinishedSetupFor(
	env: HostCreateEnv,
	actor: string,
	callerDid: string
): Promise<{ groupDid: string; name: string } | null> {
	const groupDid = await groupActorToDid(actor);
	const group = groupDid ? await getGroupByDid(env.DB, groupDid) : null;
	if (!group || group.members_space_uri !== null) return null;
	const pending = await pendingSetup(env, group.group_did);
	return pending?.by === callerDid
		? { groupDid: group.group_did, name: pending.create.name }
		: null;
}

/** The group page's "finish setting up", for the person whose create stopped. */
export async function finishGroupSetup(input: {
	env: HostCreateEnv;
	groupDid: string;
	callerDid: string;
	credentialFor?: typeof resolveGroupCredential;
}): Promise<GroupFormResult> {
	const { env, groupDid, callerDid } = input;
	const pending = await pendingSetup(env, groupDid);
	const group = await getGroupByDid(env.DB, groupDid);
	if (!pending || pending.by !== callerDid || !group || group.members_space_uri !== null) {
		return { ok: false, error: 'This group has no unfinished setup of yours.' };
	}
	const credential = await (input.credentialFor ?? resolveGroupCredential)(
		env,
		groupDid,
		callerDid
	);
	if (!credential) {
		return {
			ok: false,
			error: 'This site no longer holds your access to the group, so it cannot finish it.'
		};
	}
	const result = await setUpHostGroup(
		env,
		callerDid,
		pending.create,
		credential,
		groupHostOrigin(env)!,
		group
	);
	if (!result.ok) return result;
	await dropPendingSetup(env, groupDid);
	return { ok: true };
}

export async function setUpHostGroup(
	env: HostCreateEnv,
	creatorDid: string,
	fields: HostCreateFields,
	credential: LinkedGroupCredential,
	hostOrigin: string,
	existing: GroupRow | null = null
): Promise<GroupFormResult<{ groupDid: string }>> {
	const groupDid = credential.session.did;
	const made = (step: string, detail: string, then: string) => ({
		ok: false as const,
		error: `The group host made ${groupDid}, but ${step} failed (${detail}). ${then}`
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
			return made(
				'saving it on this site',
				knownFormError(e)?.error ?? errorText(e),
				'Tell an administrator before creating it again.'
			);
		}
	}
	// Before any write, since the index resolves the DID through this.
	await registerGroupIdentity(env.DB, { did: groupDid, handle: null, pds: hostOrigin });
	await refreshGroupHandle(env.DB, groupDid);

	const uris = groupSpaceUris(groupDid);
	const withSpaces = {
		...group,
		about_space_uri: uris.aboutSpaceUri,
		members_space_uri: uris.membersSpaceUri
	};
	try {
		await hostMethods({ db: env.DB, env, group, credential }).createSpace(
			{ callerDid: creatorDid },
			{
				type: CALENDAR_SPACE_TYPE,
				skey: SPACE_SKEY,
				access: {
					public: false,
					grants: GROUP_ROLES.map((role) => ({
						role,
						scopes: [spaceReadScope(CALENDAR_SPACE_TYPE)]
					}))
				}
			}
		);
	} catch (e) {
		return made(
			'making its calendar space',
			errorText(e),
			'Open the group’s page to finish setting it up.'
		);
	}

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
		const written = existing
			? new Set((await readGroupAbout(reader, withSpaces)).rules.map((rule) => rule.order))
			: new Set<number>();
		const rules = splitRuleLines(fields.rules).map((text, order) => ({ text, order }));
		await createGroupRules({ ...as, rules: rules.filter((rule) => !written.has(rule.order)) });
		// Only `public` follows the form; the host's grants stay.
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
		return made(
			'writing its profile and settings',
			errorText(e),
			'Open the group’s page to finish setting it up.'
		);
	}
	return { ok: true, groupDid };
}

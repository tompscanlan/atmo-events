// The one way into a group page, so no route makes a lookup of its own that could reveal
// a group. A visitor sees a group only through its declaration; a person the group's host
// lets read its meta space sees it with their own access; someone who linked it sees it
// as the group does. Every refusal is the same 404.
import { env, waitUntil } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import {
	TokenInvalidError,
	TokenRefreshError,
	TokenRevokedError,
	type OAuthSession
} from '@atcute/oauth-node-client';
import {
	atGroupHost,
	isDeclared,
	readCards,
	readGroupMeta,
	repoHasDeclaration,
	resolveGroup,
	storeCard,
	type GroupMeta
} from './group';
import { holdsAcceptanceGrant, holdsGroupScopes, holdsMetaRead, holdsSpaceList } from '../scopes';
import { callerSession, type CallerSession } from './caller';
import { confirmOnVisit, groupSpacesOf, readMetaAsPerson } from './person';
import { groupHandle, groupSession, groupSignInAvailable } from './sign-in';
import { isSpaceAccessDenied } from './space-credential';
import { isAuthRefused, isRoleRefused, type XrpcHandle } from './xrpc';

/** Byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

export const GROUP_UNCHECKED = 'This group could not be checked right now. Try again shortly.';

export type Viewer = Pick<App.Locals, 'did' | 'session'>;

export interface GroupView {
	did: string;
	handle: string | null;
	name: string;
	description: string | null;
	/** Whether this site may link it: the group is at its group host. */
	atHost: boolean;
	/** Present when the caller linked the group and the session still works. */
	linked: { meta: GroupMeta; listed: boolean } | null;
	/** The caller linked it, but the group's PDS no longer takes the session. */
	relink: boolean;
	/** Present when the host let the caller read the group with their own access. */
	personal: GroupMeta | null;
	/** Signed in, but their sign-in does not yet grant what groups need. */
	askAccess: boolean;
}

export interface GroupWriter {
	did: string;
	handle: XrpcHandle;
}

/** Only linking again fixes these; an outage at the group's PDS is not one of them. */
function needsRelink(e: unknown): boolean {
	return (
		isAuthRefused(e) ||
		e instanceof TokenRefreshError ||
		e instanceof TokenRevokedError ||
		e instanceof TokenInvalidError
	);
}

async function linkedRead(
	session: OAuthSession,
	groupDid: string,
	personDid: string
): Promise<{ meta: GroupMeta; listed: boolean } | 'refused' | 'no-role'> {
	const handle = groupHandle(session, personDid);
	try {
		const [meta, listed] = await Promise.all([
			readGroupMeta(handle, groupDid),
			repoHasDeclaration(handle, groupDid)
		]);
		return { meta, listed };
	} catch (e) {
		if (needsRelink(e)) return 'refused';
		// Their role was lowered or taken away: the page shows the group as they may see it
		// without the link, since linking again would bring back the same link.
		if (isRoleRefused(e)) return 'no-role';
		throw e;
	}
}

/** Whether the caller's own PDS lists a space of the group's: someone who wrote into it. */
async function knowsGroup(caller: CallerSession, groupDid: string): Promise<boolean> {
	if (!holdsSpaceList(caller.scope)) return false;
	try {
		return (await groupSpacesOf(caller)).includes(groupDid);
	} catch (e) {
		console.warn(`[groups] ${caller.did}'s group spaces could not be listed:`, e);
		return false;
	}
}

/** The host's answer for the caller. `unsure` when it could not be had for a group the
 *  caller knows, or at all: never a reason to act, only to say "try again". */
async function personalRead(
	caller: CallerSession,
	groupDid: string
): Promise<{ meta: GroupMeta | null; unsure: boolean }> {
	try {
		return { meta: await readMetaAsPerson(caller, groupDid), unsure: false };
	} catch (e) {
		if (isSpaceAccessDenied(e)) {
			return { meta: null, unsure: e.ambiguous && (await knowsGroup(caller, groupDid)) };
		}
		console.error(`[groups] ${groupDid}: the meta space could not be read for ${caller.did}:`, e);
		return { meta: null, unsure: true };
	}
}

export async function groupView(actor: string, viewer: Viewer): Promise<GroupView> {
	if (!env.GROUP_HOST_URL) error(404, GROUP_NOT_FOUND);
	const group = await resolveGroup(actor);
	if (!group) error(404, GROUP_NOT_FOUND);
	const callerDid = viewer.did;
	const atHost = atGroupHost(group);

	let linked: GroupView['linked'] = null;
	let relink = false;
	let session: OAuthSession | null = null;
	if (callerDid) {
		try {
			session = await groupSession(group.did, callerDid);
		} catch (e) {
			// A stored session that no longer restores: linking again replaces it.
			console.warn(`[groups] ${callerDid}'s session for ${group.did} did not restore:`, e);
			relink = true;
		}
	}
	if (session && callerDid) {
		const read = await linkedRead(session, group.did, callerDid);
		if (read === 'refused') relink = true;
		else if (read !== 'no-role') {
			linked = read;
			await storeCard(group, read.meta).catch((e) => {
				console.warn(`[groups] ${group.did}: the card could not be stored:`, e);
			});
		}
	}

	// Only for a group at this site's host: elsewhere a DID's PDS answers whatever it likes,
	// and such a group shows only through its declaration.
	const caller = await callerSession(viewer.session ?? null);
	let personal: GroupMeta | null = null;
	let unsure = false;
	if (!linked && atHost && caller && holdsMetaRead(caller.scope)) {
		({ meta: personal, unsure } = await personalRead(caller, group.did));
		if (personal) {
			await storeCard(group, personal).catch((e) => {
				console.warn(`[groups] ${group.did}: the card could not be stored:`, e);
			});
			if (holdsAcceptanceGrant(caller.scope, group.did, 'create')) {
				waitUntil(confirmOnVisit(caller, group.did));
			}
		}
	}

	if (!linked && !relink && !personal) {
		let declared: boolean;
		try {
			declared = await isDeclared(group.did);
		} catch (e) {
			console.error(`[groups] ${group.did}: the declaration could not be read:`, e);
			error(503, GROUP_UNCHECKED);
		}
		if (!declared) error(unsure ? 503 : 404, unsure ? GROUP_UNCHECKED : GROUP_NOT_FOUND);
	}

	const read = linked?.meta.profile ?? personal?.profile;
	const card = read ? null : (await readCards([group.did])).get(group.did);
	const profile = read ?? card ?? null;
	return {
		did: group.did,
		handle: group.handle,
		name: profile?.name ?? group.handle ?? group.did,
		description: profile?.description ?? null,
		atHost: groupSignInAvailable() && atHost,
		linked,
		relink,
		personal,
		askAccess: atHost && caller !== null && !holdsGroupScopes(caller.scope)
	};
}

/** For a write as the group: the caller's own linked session, or the same 404. */
export async function requireGroupWriter(
	groupDid: string,
	callerDid: string | null
): Promise<GroupWriter> {
	if (!callerDid || !env.GROUP_HOST_URL) error(404, GROUP_NOT_FOUND);
	const session = await groupSession(groupDid, callerDid).catch(() => null);
	if (!session) error(404, GROUP_NOT_FOUND);
	return { did: groupDid, handle: groupHandle(session, callerDid) };
}

/** Always the DID, never a handle, which a group can change. */
export function groupPath(groupDid: string, sub?: string): string {
	return sub ? `/groups/${groupDid}/${sub}` : `/groups/${groupDid}`;
}

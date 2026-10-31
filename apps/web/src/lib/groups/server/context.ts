// The one way into a group page, so no route makes a lookup of its own that could reveal
// a group. A visitor sees a group only through its declaration; someone who linked it
// sees it as the group does. Every refusal is the same 404.
import { env } from 'cloudflare:workers';
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
import { groupHandle, groupSession, groupSignInAvailable } from './sign-in';
import { isAuthRefused, isRoleRefused, type XrpcHandle } from './xrpc';

/** Byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

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

export async function groupView(actor: string, callerDid: string | null): Promise<GroupView> {
	if (!env.GROUP_HOST_URL) error(404, GROUP_NOT_FOUND);
	const group = await resolveGroup(actor);
	if (!group) error(404, GROUP_NOT_FOUND);

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

	if (!linked && !relink) {
		let declared: boolean;
		try {
			declared = await isDeclared(group.did);
		} catch (e) {
			console.error(`[groups] ${group.did}: the declaration could not be read:`, e);
			error(503, 'Groups are unavailable right now');
		}
		if (!declared) error(404, GROUP_NOT_FOUND);
	}

	const card = linked?.meta.profile ? null : (await readCards([group.did])).get(group.did);
	const profile = linked?.meta.profile ?? card ?? null;
	return {
		did: group.did,
		handle: group.handle,
		name: profile?.name ?? group.handle ?? group.did,
		description: profile?.description ?? null,
		atHost: groupSignInAvailable() && atGroupHost(group),
		linked,
		relink
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

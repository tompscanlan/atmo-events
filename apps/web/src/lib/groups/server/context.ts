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
	readCachedProfiles,
	readGroupMeta,
	repoHasDeclaration,
	resolveGroup,
	storeCachedProfile,
	type GroupMeta
} from './group';
import { groupHandle, groupSession, groupSignInAvailable, hasGroupSession } from './sign-in';
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
	/** The caller has a link stored here, working or not, so they can unlink it. */
	hasLink: boolean;
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
	let hasLink = false;
	let session: OAuthSession | null = null;
	if (callerDid) {
		try {
			session = await groupSession(group.did, callerDid);
		} catch (e) {
			// A stored session that no longer restores: linking again replaces it.
			console.warn(`[groups] ${callerDid}'s session for ${group.did} did not restore:`, e);
			relink = true;
		}
		hasLink = relink || session !== null;
	}
	if (session && callerDid) {
		const read = await linkedRead(session, group.did, callerDid);
		if (read === 'refused') relink = true;
		else if (read !== 'no-role') {
			linked = read;
			await storeCachedProfile(group, read.meta).catch((e) => {
				console.warn(`[groups] ${group.did}: the cached profile could not be stored:`, e);
			});
		}
	}

	// Without a working link the caller sees what any visitor does, so the declaration decides,
	// even for someone whose link broke.
	if (!linked) {
		let declared: boolean;
		try {
			declared = await isDeclared(group.did);
		} catch (e) {
			console.error(`[groups] ${group.did}: the declaration could not be read:`, e);
			error(503, 'Groups are unavailable right now');
		}
		if (!declared) error(404, GROUP_NOT_FOUND);
	}

	const cached = linked?.meta.profile
		? null
		: (await readCachedProfiles([group.did])).get(group.did);
	const profile = linked?.meta.profile ?? cached ?? null;
	return {
		did: group.did,
		handle: group.handle,
		name: profile?.name ?? group.handle ?? group.did,
		description: profile?.description ?? null,
		atHost: groupSignInAvailable() && atGroupHost(group),
		linked,
		relink,
		hasLink
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

/** For unlinking: the caller's stored link, working or not, or the same 404. It is not
 *  restored, so a link the host refuses, or one that no longer restores, still comes off. */
export async function requireStoredLink(
	groupDid: string,
	callerDid: string | null
): Promise<string> {
	if (!callerDid || !env.GROUP_HOST_URL) error(404, GROUP_NOT_FOUND);
	if (!(await hasGroupSession(groupDid, callerDid))) error(404, GROUP_NOT_FOUND);
	return callerDid;
}

/** Always the DID, never a handle, which a group can change. */
export function groupPath(groupDid: string, sub?: string): string {
	return sub ? `/groups/${groupDid}/${sub}` : `/groups/${groupDid}`;
}

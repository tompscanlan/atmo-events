// The one way into a group page, so no route makes a lookup of its own that could reveal
// a group. A visitor sees a group only through its declaration; someone who linked it
// sees it as the group does. Every refusal is the same 404.
import { error } from '@sveltejs/kit';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { groupAbilities, type GroupAbilities } from '../scopes';
import {
	atGroupHost,
	isDeclared,
	readCachedProfiles,
	readGroupMeta,
	repoHasDeclaration,
	resolveGroup,
	storeCachedProfile,
	syncDeclarationIndex,
	type GroupMeta
} from './group';
import { requireGroupsEnabled } from './enabled';
import { unfinishedGroup } from './create';
import {
	groupHandle,
	groupSession,
	groupSignInAvailable,
	hasGroupSession,
	linkAskedCurrentScope
} from './sign-in';
import { errorKind, isLinkBroken, isRoleRefused, type XrpcHandle } from './xrpc';

/** Byte for byte, so the causes cannot be told apart. */
export const GROUP_NOT_FOUND = 'Group not found';

/** To someone who linked the group, whose role does not let the link post as it. */
export const NO_POSTING = "Your role in this group doesn't let you post its events.";
/** The same, for the group's settings. */
export const NO_SETTINGS = "Your role in this group doesn't let you change its settings.";

export interface GroupView {
	did: string;
	handle: string | null;
	name: string;
	description: string | null;
	/** Whether this site may link it: the group is at its group host. */
	atHost: boolean;
	/** Present when the caller linked the group and the session still works. */
	linked: LinkedGroup | null;
	/** The caller linked it, but the group's PDS no longer takes the session. */
	relink: boolean;
	/** The caller has a link stored here, working or not, so they can unlink it. */
	hasLink: boolean;
}

export interface LinkedGroup {
	meta: GroupMeta;
	listed: boolean;
	/** What the session's granted scope lets it do; the host still checks the roles at each write. */
	can: GroupAbilities;
	/** The link was approved for less than this site asks for now, and lacks some of it: approving
	 *  again may bring the rest. False once it was approved for all of it, whatever the roles kept. */
	reapprove: boolean;
	/** The caller made the group here, and setting it up did not finish at the link. */
	unfinished: boolean;
}

export interface GroupWriter {
	did: string;
	handle: XrpcHandle;
}

async function linkedRead(
	session: OAuthSession,
	groupDid: string,
	personDid: string
): Promise<LinkedGroup | 'refused' | 'no-role'> {
	const handle = groupHandle(session, personDid);
	try {
		const [meta, listed, token, current, setup] = await Promise.all([
			readGroupMeta(handle, groupDid),
			repoHasDeclaration(handle, groupDid),
			// As granted at the approval; a refresh would not change it.
			session.getTokenInfo(false),
			linkAskedCurrentScope(groupDid, personDid),
			unfinishedGroup(personDid, groupDid)
		]);
		const can = groupAbilities(token.scope, groupDid);
		const everything = can.post && can.list && can.settings;
		return { meta, listed, can, reapprove: !current && !everything, unfinished: setup !== null };
	} catch (e) {
		if (isLinkBroken(e)) return 'refused';
		// Their role was lowered or taken away, so the session's scope or its credential for the
		// meta space was refused: the page shows the group as they may see it without the link,
		// since linking again would bring back the same link.
		if (isRoleRefused(e)) {
			const why = isSpaceAccessDenied(e) ? e.reason : errorKind(e);
			console.info(`[groups] ${groupDid} refused ${personDid}'s link: ${why}`);
			return 'no-role';
		}
		throw e;
	}
}

export async function groupView(actor: string, callerDid: string | null): Promise<GroupView> {
	requireGroupsEnabled();
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
			// Listed or unlisted by the group host itself, perhaps, which the index may not know yet.
			await syncDeclarationIndex(group.did, read.listed);
		}
	}

	// Without a working link the caller sees what any visitor does, so the declaration decides,
	// even for someone whose link broke. Except that someone with a link stored here still gets the
	// page, to unlink it: bare, with only what anyone could learn, its handle and public events,
	// never a cached name.
	let bare = false;
	if (!linked) {
		let declared: boolean;
		try {
			declared = await isDeclared(group.did);
		} catch (e) {
			console.error(`[groups] ${group.did}: the declaration could not be read:`, e);
			error(503, 'Groups are unavailable right now');
		}
		if (!declared && !hasLink) error(404, GROUP_NOT_FOUND);
		bare = !declared;
	}

	const cached =
		linked?.meta.profile || bare ? null : (await readCachedProfiles([group.did])).get(group.did);
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
	requireGroupsEnabled();
	if (!callerDid) error(404, GROUP_NOT_FOUND);
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
	requireGroupsEnabled();
	if (!callerDid) error(404, GROUP_NOT_FOUND);
	if (!(await hasGroupSession(groupDid, callerDid))) error(404, GROUP_NOT_FOUND);
	return callerDid;
}

/** Always the DID, never a handle, which a group can change. */
export function groupPath(groupDid: string, sub?: string): string {
	return sub ? `/groups/${groupDid}/${sub}` : `/groups/${groupDid}`;
}

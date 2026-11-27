// The one way into a group page, so no route makes a lookup of its own that could reveal
// a group. A visitor sees a group only through its declaration; someone who linked it sees it as
// the group does. Every refusal is the same 404.
import { error } from '@sveltejs/kit';
import type { OAuthSession } from '@atcute/oauth-node-client';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { groupAbilities, holdsEveryAbility, type GroupAbilities } from '../scopes';
import {
	atGroupHost,
	isDeclared,
	readCachedProfiles,
	readLinkedMeta,
	repoHasDeclaration,
	resolveGroup,
	storeCachedProfile,
	syncDeclarationIndex,
	type LinkedMeta
} from './group';
import { requireGroupsEnabled } from './enabled';
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

export interface GroupView {
	did: string;
	handle: string | null;
	name: string;
	description: string | null;
	/** Its website, as its about record gives it: only an http(s) URL. */
	website: string | null;
	/** The group's own address, from its verified handle: see `groupHome`. */
	home: string | null;
	/** Its group host's own site: the origin of the PDS its DID document names. */
	hostSite: GroupHostSite | null;
	/** Whether this site may link it: the group is at its group host. */
	atHost: boolean;
	/** Present when the caller linked the group and the session still works. */
	linked: LinkedGroup | null;
	/** The caller linked it, but the group's PDS no longer takes the session. */
	relink: boolean;
	/** The caller has a link stored here, working or not, so they can unlink it. */
	hasLink: boolean;
	/** The caller's link could not reach the group's host just now, so the page shows what a
	 *  visitor sees. */
	unreachable: boolean;
}

export interface LinkedGroup {
	meta: LinkedMeta;
	listed: boolean;
	/** What the session's granted scope lets it do; the host still checks the roles at each write. */
	can: GroupAbilities;
	/** The link was approved for less than this site asks for now, and lacks some of it: approving
	 *  again may bring the rest. False once it was approved for all of it, whatever the roles kept. */
	reapprove: boolean;
}

export interface GroupWriter {
	did: string;
	handle: XrpcHandle;
}

/** The longest a page waits on the reads through a link, every call in them together: each call
 *  has its own limit, and a host that is down would otherwise cost the sum of them. */
export const LINKED_READ_LIMIT_MS = 10_000;

type LinkedRead = LinkedGroup | 'refused' | 'no-role' | 'unreachable';

/** `unreachable` when the group's host did not answer in time, or failed: the page then shows
 *  what a visitor sees, never an error, so the person can still see its events and unlink it. */
async function linkedRead(
	session: OAuthSession,
	groupDid: string,
	personDid: string
): Promise<LinkedRead> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<'unreachable'>((resolve) => {
		timer = setTimeout(() => {
			console.warn(`[groups] ${groupDid}: ${personDid}'s link had no answer in time`);
			resolve('unreachable');
		}, LINKED_READ_LIMIT_MS);
	});
	try {
		return await Promise.race([readLinked(session, groupDid, personDid), late]);
	} finally {
		clearTimeout(timer);
	}
}

async function readLinked(
	session: OAuthSession,
	groupDid: string,
	personDid: string
): Promise<LinkedRead> {
	const handle = groupHandle(session, personDid);
	try {
		const [meta, listed, token, current] = await Promise.all([
			readLinkedMeta(handle, groupDid),
			repoHasDeclaration(handle, groupDid),
			// As granted at the approval; a refresh would not change it.
			session.getTokenInfo(false),
			linkAskedCurrentScope(groupDid, personDid)
		]);
		const can = groupAbilities(token.scope);
		return {
			meta,
			listed,
			can,
			reapprove: !current && !holdsEveryAbility(can)
		};
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
		console.error(`[groups] ${groupDid}: ${personDid}'s link could not read it: ${errorKind(e)}`);
		return 'unreachable';
	}
}

export async function groupView(actor: string, callerDid: string | null): Promise<GroupView> {
	requireGroupsEnabled();
	const group = await resolveGroup(actor);
	if (!group) error(404, GROUP_NOT_FOUND);
	const atHost = atGroupHost(group);

	let linked: GroupView['linked'] = null;
	let relink = false;
	let hasLink = false;
	let unreachable = false;
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
	// A link is read only while the group is at this site's group host, and through it: one to a
	// group that moved, or made at a host this site no longer uses, can only come off.
	if (session && callerDid && atHost && (await linkAtGroupHost(session))) {
		const read = await linkedRead(session, group.did, callerDid);
		if (read === 'refused') relink = true;
		else if (read === 'unreachable') unreachable = true;
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

	const read = linked?.meta.profile;
	const cached = read || bare ? null : (await readCachedProfiles([group.did])).get(group.did);
	const profile = read ?? cached ?? null;
	return {
		did: group.did,
		handle: group.handle,
		name: profile?.name ?? group.handle ?? group.did,
		description: profile?.description ?? null,
		website: profile?.website ?? null,
		home: groupHome(group.handle),
		hostSite: groupHostSite(group.pds),
		atHost: groupSignInAvailable() && atHost,
		linked,
		relink,
		hasLink,
		unreachable
	};
}

/** The group's own address: its handle, which was checked both ways, as a web address. Whatever
 *  is served there is the group's to say: a group host may send a visitor at a group's address on
 *  to the group's page there (bluesky-social/group-host does), and a handle on a domain of the
 *  group's own may serve anything. So it is only ever shown as the group's own address, never as
 *  its group host. Null without a handle. */
export function groupHome(handle: string | null): string | null {
	if (!handle) return null;
	try {
		const url = new URL(`https://${handle}/`);
		return url.hostname === handle.toLowerCase() && url.pathname === '/' ? url.href : null;
	} catch {
		return null;
	}
}

export interface GroupHostSite {
	/** The origin, as a link. */
	url: string;
	/** Its host name, as the link is labelled. */
	name: string;
}

/** The group host's own site, where its groups' members, requests to join and roles are managed:
 *  the origin of the PDS the group's DID document names, which for a group at this site's group
 *  host is the host this site was set up with. Only its origin, since no path is the same at every
 *  group host. Null for one that is not an https (or, for a local host, http) address. */
export function groupHostSite(pds: string | null | undefined): GroupHostSite | null {
	if (!pds) return null;
	try {
		const url = new URL(pds);
		if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
		return { url: `${url.origin}/`, name: url.host };
	} catch {
		return null;
	}
}

/** Whether the session's PDS, as it was when the link was approved, is this site's group host now:
 *  read from the stored session, with no call to the host. */
async function linkAtGroupHost(session: OAuthSession): Promise<boolean> {
	try {
		return atGroupHost({ pds: (await session.getTokenInfo(false)).aud });
	} catch {
		// What the session says of itself is read again by the linked read, which tells a broken
		// link from an outage.
		return true;
	}
}

/** For a write as the group: the caller's own linked session, or the same 404. Only a link to a
 *  group at this site's group host, as the session says, which costs no call to the host. */
export async function requireGroupWriter(
	groupDid: string,
	callerDid: string | null
): Promise<GroupWriter> {
	requireGroupsEnabled();
	if (!callerDid) error(404, GROUP_NOT_FOUND);
	const session = await groupSession(groupDid, callerDid).catch(() => null);
	if (!session || !(await linkAtGroupHost(session))) error(404, GROUP_NOT_FOUND);
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

// The one way into a group page, so no route makes a lookup of its own that could reveal
// a group. A visitor sees a group only through its declaration; a person the group host lets
// read its meta space sees it with their own access; someone who linked it sees it as the
// group does. Every refusal is the same 404.
import { waitUntil } from 'cloudflare:workers';
import { error } from '@sveltejs/kit';
import type { OAuthSession } from '@atcute/oauth-node-client';
import type { CallerSession } from '#lib/private-events/server/caller.js';
import type { SpaceReader } from '#lib/spaces/server/space-read.js';
import {
	isSpaceAccessDenied,
	type SpaceAccessDenied
} from '#lib/spaces/server/space-credential.js';
import {
	ACTOR_GROUPS_NSID,
	groupAbilities,
	holdsConfirmationGrant,
	holdsEveryAbility,
	holdsMetaRead,
	holdsParticipate,
	holdsRpc,
	type GroupAbilities
} from '../scopes';
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
import { unfinishedGroup } from './create';
import { confirmAdmitted, hasConfirmation, joinRequested } from './confirmation';
import { actorGroups } from './host';
import { isMemberAsPerson, personReader, readMetaAsPerson, type PersonalMeta } from './person';
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

/** When the host could not say whether the person may see a group they are in. */
export const GROUP_UNCHECKED = 'This group could not be checked right now. Try again shortly.';

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
	/** The caller's link could not reach the group's host just now, so the page shows what a
	 *  visitor sees. */
	unreachable: boolean;
	/** Present when the group host let the caller read the group with their own access. */
	personal: PersonalMeta | null;
	/** Whether the host's records count the caller a member; null when they could not be read. */
	member: boolean | null;
	/** For a member whose sign-in may write it: whether their own confirmation is there. Null for
	 *  anyone else, and when it could not be read. */
	confirmed: boolean | null;
	/** Signed in, at a group at this site's host, without the group permissions their own sign-in
	 *  needs to join it or see it as a member. */
	askAccess: boolean;
}

export interface LinkedGroup {
	meta: LinkedMeta;
	listed: boolean;
	/** What the session's granted scope lets it do; the host still checks the roles at each write. */
	can: GroupAbilities;
	/** The link was approved for less than this site asks for now, and lacks some of it: approving
	 *  again may bring the rest. False once it was approved for all of it, whatever the roles kept. */
	reapprove: boolean;
	/** The caller made the group here, and setting it up did not finish at the link: what they asked
	 *  of it, which says what is left to do. Null for any other group. */
	unfinished: { public: boolean; listed: boolean } | null;
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
		const [meta, listed, token, current, setup] = await Promise.all([
			readLinkedMeta(handle, groupDid),
			repoHasDeclaration(handle, groupDid),
			// As granted at the approval; a refresh would not change it.
			session.getTokenInfo(false),
			linkAskedCurrentScope(groupDid, personDid),
			unfinishedGroup(personDid, groupDid)
		]);
		const can = groupAbilities(token.scope, groupDid);
		return {
			meta,
			listed,
			can,
			reapprove: !current && !holdsEveryAbility(can),
			unfinished: setup && { public: setup.public, listed: setup.listed }
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

/** Whether the person's groups at the host include this one, by the host's own list; null when
 *  their sign-in can't ask for it, or the host did not answer. */
async function hostListsGroup(caller: CallerSession, groupDid: string): Promise<boolean | null> {
	if (!holdsRpc(caller.scope, ACTOR_GROUPS_NSID)) return null;
	try {
		return (await actorGroups(caller)).some((group) => group.did === groupDid);
	} catch (e) {
		console.warn(`[groups] ${caller.did}'s groups could not be listed: ${errorKind(e)}`);
		return null;
	}
}

const knowsGroup = async (caller: CallerSession, groupDid: string) =>
	(await hostListsGroup(caller, groupDid)) === true;

/** Whether the person is a member. An ambiguous refusal of the members space is settled by the
 *  host's own list of their groups, so a brief failure never shows a member a Join button: null,
 *  could not tell, unless the list says they are not in it. */
async function membershipOf(
	caller: CallerSession,
	reader: SpaceReader,
	groupDid: string
): Promise<boolean | null> {
	try {
		return await isMemberAsPerson(reader, groupDid, caller.did);
	} catch (e) {
		if (isSpaceAccessDenied(e) && isAmbiguousDenial(e)) {
			return (await hostListsGroup(caller, groupDid)) === false ? false : null;
		}
		console.warn(`[groups] ${groupDid}: ${caller.did}'s membership could not be read:`, e);
		return null;
	}
}

/** A PDS answers SpaceNotFound for a refusal, and also when it could not reach the space's
 *  authority: a reason to hide the space, never to act on it. */
const isAmbiguousDenial = (e: SpaceAccessDenied) => e.reason.endsWith('SpaceNotFound');

interface PersonalRead {
	meta: PersonalMeta | null;
	member: boolean | null;
	confirmed: boolean | null;
	/** The host could not be asked about a group the person is in: never a reason to act, only to
	 *  say "try again". */
	unsure: boolean;
}

/** A member's own confirmation. Written only for a request they made here that the host has since
 *  admitted, on the first visit after; otherwise only read, so the page can offer to confirm.
 *  Never written for merely opening the page. */
async function ownConfirmation(
	caller: CallerSession,
	reader: SpaceReader,
	groupDid: string
): Promise<boolean | null> {
	if (await joinRequested(caller.did, groupDid)) {
		waitUntil(confirmAdmitted(caller, groupDid));
		return true;
	}
	return hasConfirmation(reader, groupDid, caller.did).catch((e) => {
		console.warn(`[groups] ${groupDid}: ${caller.did}'s confirmation could not be read:`, e);
		return null;
	});
}

/** The group read with the caller's own access, whether they are a member, and, for a member,
 *  whether they confirmed it. */
async function personalRead(caller: CallerSession, groupDid: string): Promise<PersonalRead> {
	const reader = personReader(caller);
	let meta: PersonalMeta;
	try {
		meta = await readMetaAsPerson(reader, groupDid);
	} catch (e) {
		if (isSpaceAccessDenied(e)) {
			const unsure = isAmbiguousDenial(e) && (await knowsGroup(caller, groupDid));
			return { meta: null, member: null, confirmed: null, unsure };
		}
		console.error(`[groups] ${groupDid}: the meta space could not be read for ${caller.did}:`, e);
		return { meta: null, member: null, confirmed: null, unsure: true };
	}
	const member = await membershipOf(caller, reader, groupDid);
	const confirmed =
		member && holdsConfirmationGrant(caller.scope, 'create', groupDid)
			? await ownConfirmation(caller, reader, groupDid)
			: null;
	return { meta, member, confirmed, unsure: false };
}

/** `person` is the caller's own session, for the page that reads the group as they may see it. */
export async function groupView(
	actor: string,
	callerDid: string | null,
	person: CallerSession | null = null
): Promise<GroupView> {
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

	// Only for a group at this site's host: elsewhere a DID's PDS answers whatever it likes, and
	// such a group shows only through its declaration.
	const caller = person && person.did === callerDid ? person : null;
	let personal: PersonalRead = { meta: null, member: null, confirmed: null, unsure: false };
	if (atHost && caller && holdsMetaRead(caller.scope)) {
		personal = await personalRead(caller, group.did);
		if (personal.meta && !linked) {
			await storeCachedProfile(group, personal.meta).catch((e) => {
				console.warn(`[groups] ${group.did}: the cached profile could not be stored:`, e);
			});
		}
	}

	// Without a working link or their own access the caller sees what any visitor does, so the
	// declaration decides, even for someone whose link broke. Except that someone with a link
	// stored here still gets the page, to unlink it: bare, with only what anyone could learn, its
	// handle and public events, never a cached name.
	let bare = false;
	if (!linked && !personal.meta) {
		let declared: boolean;
		try {
			declared = await isDeclared(group.did);
		} catch (e) {
			console.error(`[groups] ${group.did}: the declaration could not be read:`, e);
			error(503, 'Groups are unavailable right now');
		}
		if (!declared && !hasLink) {
			error(personal.unsure ? 503 : 404, personal.unsure ? GROUP_UNCHECKED : GROUP_NOT_FOUND);
		}
		bare = !declared;
	}

	const read = linked?.meta.profile ?? personal.meta?.profile;
	const cached = read || bare ? null : (await readCachedProfiles([group.did])).get(group.did);
	const profile = read ?? cached ?? null;
	return {
		did: group.did,
		handle: group.handle,
		name: profile?.name ?? group.handle ?? group.did,
		description: profile?.description ?? null,
		atHost: groupSignInAvailable() && atHost,
		linked,
		relink,
		hasLink,
		unreachable,
		personal: personal.meta,
		member: personal.member,
		confirmed: personal.confirmed,
		askAccess: atHost && caller !== null && !holdsParticipate(caller.scope)
	};
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

// Invitations to private events. Each person has an inbox, a space on their own PDS that anyone
// may write to and only they read. A host writes an invite, in the host's own repo, into each
// guest's inbox, and the guest's own sign-in reads it. atmo keeps no list of who invited whom: the
// invite on the host's PDS is the only record.
import type { Cookies } from '@sveltejs/kit';
import { isSpaceAccessDenied } from '#lib/spaces/server/space-credential.js';
import { credentialSpaceReader } from '#lib/spaces/server/space-read.js';
import { xrpc, XrpcError } from '#lib/spaces/server/xrpc.js';
import {
	INBOX_KEY,
	INBOX_TYPE,
	inboxSpace,
	INVITE_COLLECTION,
	privateEventPath,
	privateEventSpace,
	privateEventUri
} from '../ids';
import { holdsInboxGrant, holdsInviterGrant } from '../scopes';
import type { CallerSession } from './caller';
import { invitationsEnabled } from './enabled';
import { verifiedHandle } from './people';

const INBOX_COOKIE = 'atmo_private_inbox';
const INBOX_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Makes the person's inbox the first time a page sees their grant for it, and remembers that in
 *  this browser so later pages make no call. An invite written before the inbox exists is never
 *  listed in it afterwards, so it is made as early as the grant allows. `again` when the inbox was
 *  found missing since, as after it was deleted elsewhere. A failure is only logged: the page it
 *  ran on has nothing to do with invitations. */
export async function ensureInbox(
	caller: CallerSession,
	cookies: Pick<Cookies, 'get' | 'set'>,
	url: URL,
	again = false
): Promise<void> {
	if (!invitationsEnabled() || !holdsInboxGrant(caller.scope, caller.did)) return;
	if (!again && cookies.get(INBOX_COOKIE) === caller.did) return;
	try {
		await xrpc(caller.handle, 'com.atproto.space.createSpace', {
			body: {
				spaceType: INBOX_TYPE,
				skey: INBOX_KEY,
				policy: { $type: 'com.atproto.memberspace.policy', publicWrite: true }
			}
		});
	} catch (e) {
		if (!(e instanceof XrpcError && e.error === 'SpaceAlreadyExists')) {
			console.error(`[private-events] ${caller.did}: invitation inbox not made:`, e);
			return;
		}
	}
	cookies.set(INBOX_COOKIE, caller.did, {
		path: '/',
		maxAge: INBOX_MAX_AGE_SECONDS,
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:'
	});
}

/** A grant held from when invitations were on does nothing once a deployment turns them off. */
export function canInvite(caller: CallerSession): boolean {
	return invitationsEnabled() && holdsInviterGrant(caller.scope);
}

function invite(host: string, guest: string, rkey: string) {
	return { space: inboxSpace(guest), repo: host, collection: INVITE_COLLECTION, rkey };
}

/** Never throws: the guest is on the list either way, and the host's link still reaches them. A PDS
 *  takes the write whether or not the guest has an inbox, so it says nothing about delivery. An
 *  invite already there is refused, since changing one takes a permission atmo doesn't ask for. */
export async function sendInvite(
	caller: CallerSession,
	guest: string,
	rkey: string
): Promise<void> {
	if (!canInvite(caller)) return;
	const record = {
		$type: INVITE_COLLECTION,
		subject: { uri: privateEventUri(caller.did, rkey) },
		createdAt: new Date().toISOString()
	};
	await xrpc(caller.handle, 'com.atproto.space.putRecord', {
		body: { ...invite(caller.did, guest, rkey), record }
	}).catch((e) => console.info(`[private-events] ${caller.did}: no invite to ${rkey} written:`, e));
}

/** Never throws, as above. */
export async function takeBackInvite(
	caller: CallerSession,
	guest: string,
	rkey: string
): Promise<void> {
	if (!canInvite(caller)) return;
	await xrpc(caller.handle, 'com.atproto.space.deleteRecord', {
		body: invite(caller.did, guest, rkey)
	}).catch((e) =>
		console.info(`[private-events] ${caller.did}: invite to ${rkey} not deleted:`, e)
	);
}

export interface Invitation {
	/** The event's space, to tell an invitation from an event already on the person's list. */
	space: string;
	host: string;
	hostHandle: string | null;
	/** As the host's server gave it. */
	invitedAt: string;
	href: string;
}

export interface Invitations {
	invitations: Invitation[];
	/** A server didn't answer in time, or there were too many to read, so there may be more. */
	incomplete: boolean;
	/** Their PDS has no inbox for them, so nothing can have arrived. */
	noInbox: boolean;
}

const MAX_INVITERS = 50;
const MAX_INVITES_EACH = 20;
/** For every inviter's server together, so one that stalls can't hold the page. */
const INVITERS_TIME_LIMIT_MS = 4_000;
const RKEY = /^[a-zA-Z0-9._:~-]{1,512}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** What is in the person's inbox, newest first. Each inviter's invites are in that inviter's own
 *  repo, so they are read from that inviter's server, which is all that can vouch for them: an
 *  invite counts only when it names an event of the same person who wrote it. That read tells each
 *  server that has ever written here that this person looked at their invitations, and a writer
 *  stays on the inbox's list after taking an invite back. The event itself is not read: which
 *  invitation they open, if any, stays their choice on the event's page. */
export async function readInvitations(caller: CallerSession): Promise<Invitations> {
	const space = inboxSpace(caller.did);
	const reader = credentialSpaceReader(caller);
	let writers: string[];
	try {
		writers = (await reader.writers(space)).filter((did) => did !== caller.did);
	} catch (e) {
		if (isSpaceAccessDenied(e)) return { invitations: [], incomplete: false, noInbox: true };
		console.error(`[private-events] ${caller.did}: invitation inbox unread:`, e);
		return { invitations: [], incomplete: true, noInbox: false };
	}

	// Which fifty is the PDS's order, so past that an invitation can go unseen: the page says so.
	let incomplete = writers.length > MAX_INVITERS;
	const invitations: Invitation[] = [];
	const now = Date.now();
	const each = writers.slice(0, MAX_INVITERS).map(async (host) => {
		const listed = await reader
			.list({ space, repo: host, collection: INVITE_COLLECTION, limit: MAX_INVITES_EACH })
			.catch((e) => {
				console.info(`[private-events] ${host}'s invites to ${caller.did} unread:`, e);
				return null;
			});
		if (!listed || listed.more) incomplete = true;
		const theirs = (listed?.records ?? []).flatMap(({ rkey, value }) => {
			const subject = value.subject as { uri?: unknown } | undefined;
			const invitedAt = value.createdAt;
			// A key of dots would turn the link into another address.
			if (!RKEY.test(rkey) || /^\.+$/.test(rkey)) return [];
			if (subject?.uri !== privateEventUri(host, rkey)) return [];
			if (typeof invitedAt !== 'string' || !DATETIME.test(invitedAt)) return [];
			const at = Date.parse(invitedAt);
			// The inviter's own word: a date ahead of now would hold theirs at the top.
			if (Number.isNaN(at)) return [];
			return [{ rkey, invitedAt: new Date(Math.min(at, now)).toISOString() }];
		});
		if (theirs.length === 0) return;
		const hostHandle = await verifiedHandle(host);
		for (const { rkey, invitedAt } of theirs) {
			invitations.push({
				space: privateEventSpace(host, rkey),
				host,
				hostHandle,
				invitedAt,
				href: privateEventPath(hostHandle ?? host, rkey)
			});
		}
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<'late'>((resolve) => {
		timer = setTimeout(() => resolve('late'), INVITERS_TIME_LIMIT_MS);
	});
	if ((await Promise.race([Promise.all(each), late])) === 'late') incomplete = true;
	clearTimeout(timer);
	return {
		invitations: [...invitations].sort((a, b) => Date.parse(b.invitedAt) - Date.parse(a.invitedAt)),
		incomplete,
		noInbox: false
	};
}

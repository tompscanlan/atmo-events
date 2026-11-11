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
import { verifiedHandle } from './people';

const INBOX_COOKIE = 'atmo_private_inbox';
const INBOX_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/** Makes the person's inbox the first time a page sees their grant for it, and remembers that in
 *  this browser so later pages make no call. An invite written before the inbox exists is never
 *  listed in it afterwards, so it is made as early as the grant allows. A failure is only logged:
 *  the page it ran on has nothing to do with invitations. */
export async function ensureInbox(
	caller: CallerSession,
	cookies: Pick<Cookies, 'get' | 'set'>,
	url: URL
): Promise<void> {
	if (!holdsInboxGrant(caller.scope, caller.did)) return;
	if (cookies.get(INBOX_COOKIE) === caller.did) return;
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
	if (!holdsInviterGrant(caller.scope)) return;
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
	if (!holdsInviterGrant(caller.scope)) return;
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
	/** A server didn't answer, or there were too many to read, so there may be more than these. */
	incomplete: boolean;
}

const MAX_INVITERS = 50;
const MAX_INVITES_EACH = 20;

/** What is in the person's inbox, newest first. Each inviter's invites are read from that inviter's
 *  own server, which is all that can vouch for them, so an invite counts only when it names an
 *  event of the same person who wrote it. The event itself is not read here: opening it asks the
 *  host's server who is let in, which stays the guest's choice on the event's page. Who has written
 *  is not shown from the writer list alone, since that keeps someone after they take an invite
 *  back. */
export async function readInvitations(caller: CallerSession): Promise<Invitations> {
	const space = inboxSpace(caller.did);
	const reader = credentialSpaceReader(caller);
	let writers: string[];
	try {
		writers = (await reader.writers(space)).filter((did) => did !== caller.did);
	} catch (e) {
		// No inbox yet reads as an empty one.
		if (isSpaceAccessDenied(e)) return { invitations: [], incomplete: false };
		console.error(`[private-events] ${caller.did}: invitation inbox unread:`, e);
		return { invitations: [], incomplete: true };
	}

	let incomplete = writers.length > MAX_INVITERS;
	const found = await Promise.all(
		writers.slice(0, MAX_INVITERS).map(async (host): Promise<Invitation[]> => {
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
				if (subject?.uri !== privateEventUri(host, rkey)) return [];
				if (typeof invitedAt !== 'string' || Number.isNaN(Date.parse(invitedAt))) return [];
				return [{ rkey, invitedAt }];
			});
			if (theirs.length === 0) return [];
			const hostHandle = await verifiedHandle(host);
			return theirs.map(({ rkey, invitedAt }) => ({
				space: privateEventSpace(host, rkey),
				host,
				hostHandle,
				invitedAt,
				href: privateEventPath(hostHandle ?? host, rkey)
			}));
		})
	);
	return {
		invitations: found.flat().sort((a, b) => Date.parse(b.invitedAt) - Date.parse(a.invitedAt)),
		incomplete
	};
}

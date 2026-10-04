// Linking a group: its owner signs in at the group's PDS as the group and
// authorizes this app, which keeps the session (./linked-session.ts). Running it
// again reconnects a group whose session was revoked or has lapsed.
//
// Three checks. Only the group's owner may start a link. Only the browser that
// started it, still signed in as that owner, may finish it; that is checked
// before the code is exchanged, so a refused link never stores a session. And
// the account that authorized must be the group: the client resolves the group's
// DID when the link starts and revokes a token issued to anyone else, and the
// result is checked again here.
//
// Nothing here touches the browser's cookies. The sign-in callback sets the `did`
// cookie to whoever authorized, which here would sign the owner in as the group.
import type { Did } from '@atcute/lexicons';
import type { OAuthClient, OAuthClientStores } from '@atcute/oauth-node-client';
import type { GroupRow } from '../types';
import { groupSessionScope } from './linked-session';

/** Carried through the PDS in the authorization's state. */
export interface GroupLinkState {
	groupDid: string;
	/** The owner who started the link. */
	by: string;
}

type LinkGroup = Pick<GroupRow, 'group_did' | 'owner_did'>;
type LinkClient = Pick<OAuthClient, 'authorize' | 'callback' | 'revoke'>;

export class GroupLinkRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GroupLinkRefused';
	}
}

function assertOwner(group: LinkGroup, did: string | null): asserts did is string {
	if (!did || did !== group.owner_did) {
		throw new GroupLinkRefused(`only the owner of ${group.group_did} can link its account`);
	}
}

/** The authorization URL to send the owner to. */
export async function startGroupLink(input: {
	client: LinkClient;
	group: LinkGroup;
	signedInDid: string | null;
	redirectUri: string;
}): Promise<URL> {
	assertOwner(input.group, input.signedInDid);
	const state: GroupLinkState = { groupDid: input.group.group_did, by: input.signedInDid };
	const { url } = await input.client.authorize({
		target: { type: 'account', identifier: input.group.group_did as Did },
		scope: groupSessionScope(),
		redirectUri: input.redirectUri,
		state
	});
	return url;
}

function linkState(value: unknown): GroupLinkState | null {
	if (!value || typeof value !== 'object') return null;
	const { groupDid, by } = value as Record<string, unknown>;
	if (typeof groupDid !== 'string' || !groupDid.startsWith('did:')) return null;
	if (typeof by !== 'string' || !by.startsWith('did:')) return null;
	return { groupDid, by };
}

export type GroupLinkResult =
	| { ok: true; groupDid: string }
	/** `groupDid` is null when the state did not say which group. */
	| { ok: false; groupDid: string | null; reason: string };

/** Finishes a link at the callback. Every failure after the state is read comes
 *  back as a result naming the group, so the owner can be sent back to its page;
 *  the reason is for the log. */
export async function finishGroupLink(input: {
	client: LinkClient;
	states: Pick<OAuthClientStores['states'], 'get' | 'delete'>;
	params: URLSearchParams;
	signedInDid: string | null;
	findGroup: (groupDid: string) => Promise<LinkGroup | null>;
}): Promise<GroupLinkResult> {
	const stateId = input.params.get('state');
	const stored = stateId ? await input.states.get(stateId) : undefined;
	const link = stored ? linkState(stored.userState) : null;
	if (!stateId || !link) {
		return { ok: false, groupDid: null, reason: 'unknown or expired link state' };
	}

	const group = await input.findGroup(link.groupDid);
	let refusal: string | null = null;
	if (!group) {
		refusal = `${link.groupDid} is not a group here`;
	} else if (input.signedInDid !== link.by) {
		refusal = `the link was started by ${link.by}, and the browser finishing it is signed in as ${input.signedInDid ?? 'nobody'}`;
	} else if (group.owner_did !== link.by) {
		refusal = `${link.by} no longer owns ${link.groupDid}`;
	}
	if (refusal) {
		// Single use, as the client's own callback would make it.
		await input.states.delete(stateId);
		return { ok: false, groupDid: link.groupDid, reason: refusal };
	}

	let session: { did: string };
	try {
		({ session } = await input.client.callback(input.params));
	} catch (e) {
		// A cancelled consent, a token issued to another account (the client has
		// already revoked it), or a PDS that failed the exchange.
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: e instanceof Error ? e.message : String(e)
		};
	}
	if (session.did !== link.groupDid) {
		await input.client.revoke(session.did as Did).catch((e) => {
			console.error(`[groups] revoking a link by ${session.did} failed:`, e);
		});
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: `${session.did} authorized, not the group ${link.groupDid}`
		};
	}
	return { ok: true, groupDid: link.groupDid };
}

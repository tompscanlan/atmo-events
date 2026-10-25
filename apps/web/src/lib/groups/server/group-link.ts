// Linking a group session: someone whose roles grant writes signs in at the group's
// host as the group, and this app keeps the session under them. Only a group at this
// site's host is linked; only the browser that started a link, still signed in as that
// person, may finish it, checked before the code is exchanged; and the account that
// authorized must be the group. No cookie is touched: the sign-in callback would sign
// the admin in as the group.
import type { Did } from '@atcute/lexicons';
import type { OAuthClient, OAuthClientStores } from '@atcute/oauth-node-client';
import type { GroupRow } from '../types';

import { errorText } from './errors';
import { groupSessionScope } from './session';

/** Carried through the PDS in the authorization's state. */
export interface GroupLinkState {
	groupDid: string;
	/** Whose session it becomes. */
	by: string;
}

type LinkGroup = Pick<GroupRow, 'group_did'>;
type LinkClient = Pick<OAuthClient, 'authorize' | 'callback' | 'revoke'>;

export class GroupLinkRefused extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'GroupLinkRefused';
	}
}

/** `mayConnect` is whether their roles grant writes, as their own access read them. */
export async function startGroupLink(input: {
	client: LinkClient;
	group: LinkGroup;
	signedInDid: string | null;
	mayConnect: boolean;
	atGroupHost: () => Promise<boolean>;
	redirectUri: string;
}): Promise<URL> {
	const by = input.signedInDid;
	if (!by || !input.mayConnect) {
		throw new GroupLinkRefused(
			`only someone whose roles in ${input.group.group_did} grant writes can link a group session`
		);
	}
	if (!(await input.atGroupHost().catch(() => false))) {
		throw new GroupLinkRefused(`${input.group.group_did} is not at this site's group host`);
	}
	const state: GroupLinkState = { groupDid: input.group.group_did, by };
	const { url } = await input.client.authorize({
		target: { type: 'account', identifier: input.group.group_did as Did },
		scope: groupSessionScope(),
		redirectUri: input.redirectUri,
		state
	});
	// A hint for the host's page, on the link rather than in the request.
	const hinted = new URL(url);
	hinted.searchParams.set('gh_person', by);
	return hinted;
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

/** Every failure after the state is read names the group, so the person can be sent
 *  back to its page; the reason is for the log. */
export async function finishGroupLink(input: {
	clientFor: (personDid: string) => LinkClient;
	states: Pick<OAuthClientStores['states'], 'get' | 'delete'>;
	params: URLSearchParams;
	signedInDid: string | null;
	findGroup: (groupDid: string) => Promise<LinkGroup | null>;
	mayConnect: (groupDid: string) => Promise<boolean>;
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
	} else if (!(await input.mayConnect(link.groupDid))) {
		refusal = `${link.by}'s roles in ${link.groupDid} no longer grant writes`;
	}
	if (refusal) {
		// Single use, as the client's own callback would make it.
		await input.states.delete(stateId);
		return { ok: false, groupDid: link.groupDid, reason: refusal };
	}

	const client = input.clientFor(link.by);
	let session: { did: string };
	try {
		({ session } = await client.callback(input.params));
	} catch (e) {
		return {
			ok: false,
			groupDid: link.groupDid,
			reason: errorText(e)
		};
	}
	if (session.did !== link.groupDid) {
		await client.revoke(session.did as Did).catch((e) => {
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

// A group's linked session: an OAuth session on the group's own account, which
// the group's owner grants by signing in as the group and authorizing this app.
// It replaces the app password stored at create (custody path B), and is used
// through the same seam (`groupClient` in ./session.ts).
//
// Linked sessions live in their own store, under `group:session:` in the sign-in
// sessions namespace. A sign-in session is keyed by DID too, so sharing that store
// would let a sign-in as the group overwrite the linked session with one that
// lacks the group's scope, and a link would leave a session a `did` cookie could
// restore.
import { scope, type OAuthClient, type OAuthSession } from '@atcute/oauth-node-client';
import type { Did } from '@atcute/lexicons';
import { createOAuthClientFor } from '$lib/atproto/server/oauth';
import { GROUP_DECLARATION_COLLECTION } from '../declaration-record';

export const GROUP_SESSION_PREFIX = 'group:session:';

// The one public-repo collection atmo writes as a group besides the declaration.
// Spelled here rather than imported from ./event-writer, which reaches this
// module through ./credentials.
const GROUP_EVENT_COLLECTION = 'community.lexicon.calendar.event';

/** What the group's session may do, and nothing else: its public-repo records
 *  (the declaration and public group events), its own spaces and their records,
 *  and image uploads. `authority=self` is the group's own spaces, resolved to
 *  its DID when the token is issued. The type is `*` because the PDS resolves
 *  every type a scope names, and the group.opensocial lexicons do not resolve
 *  yet (memory spaces-oauth-scopes-alpha). Proved on the alpha PDS by the
 *  2026-10-01 group-account OAuth probe, except the `repo:` and `blob:` parts. */
export const GROUP_SESSION_SCOPES: readonly string[] = [
	scope.repo({ collection: [GROUP_DECLARATION_COLLECTION, GROUP_EVENT_COLLECTION] }),
	'space:*?authority=self&manage=create&manage=update&manage=delete',
	'space:*?authority=self&collection=*',
	scope.blob({ accept: ['image/*'] })
];

/** The scope a link asks for. */
export function groupSessionScope(): string {
	return ['atproto', ...GROUP_SESSION_SCOPES].join(' ');
}

/** The client that links groups and restores their sessions. */
export function groupLinkClient(env: App.Platform['env'] | undefined): OAuthClient {
	return createOAuthClientFor(env, GROUP_SESSION_SCOPES, GROUP_SESSION_PREFIX);
}

/** Whether `groupDid` has a linked session stored. A read of the store only:
 *  it neither refreshes nor checks the session with the PDS. */
export async function hasLinkedSession(
	env: App.Platform['env'] | undefined,
	groupDid: string
): Promise<boolean> {
	const kv = env?.OAUTH_SESSIONS;
	if (!kv) return false;
	return (await kv.get(GROUP_SESSION_PREFIX + groupDid, 'text')) !== null;
}

/** The group's linked session, or null when there is none. Restored without a
 *  refresh: the session refreshes its own token on first use, so a lookup costs
 *  no round trip to the PDS. */
export async function linkedGroupSession(
	env: App.Platform['env'] | undefined,
	groupDid: string
): Promise<OAuthSession | null> {
	if (!(await hasLinkedSession(env, groupDid))) return null;
	return groupLinkClient(env).restore(groupDid as Did, { refresh: false });
}

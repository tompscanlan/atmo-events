import { dev } from '$app/environment';
import { scope } from '@atcute/oauth-node-client';
import { ABOUT_SPACE_TYPE } from '$lib/groups/types';

// writable collections — declared as a standalone scope because their NSIDs
// (`community.lexicon.*`) sit outside our namespace, so they can't go in
// `rsvp.atmo.permissionSet` (permission sets can only reference NSIDs in their
// own namespace).
export const collections = [
	'community.lexicon.calendar.event',
	'community.lexicon.calendar.rsvp'
] as const;

export const allowedCollections = [...collections, 'app.bsky.feed.post'];

export type AllowedCollection = (typeof allowedCollections)[number];

/** Reading any group's meta space with one's own access, so a signed-in person
 *  reads a public group's profile and rules, and the group's authority decides
 *  who may (TS 2026-10-15; `$lib/groups/server/member-grants.ts`). */
export const META_READ_GRANT = `space:${ABOUT_SPACE_TYPE}?authority=*&action=read`;

/** A person's own acts at a group host: joining, withdrawing a request and
 *  leaving go through their own PDS, which forwards each only when the sign-in
 *  holds that method's `rpc:` scope (`$lib/groups/server/real-host.ts`). Raw
 *  items rather than `include:group.opensocial.participate`, which also asks to
 *  create an invites space. */
export const GROUP_MEMBER_RPC_GRANTS = ['requestJoin', 'cancelJoinRequest', 'leaveGroup'].map(
	(method) => `rpc:group.opensocial.${method}?aud=*`
);

// OAuth scopes. `include:rsvp.atmo.permissionSet?aud=*` bundles every rpc method
// the deployment exposes; `aud=*` lets the same consent cover dev (tunnel DID)
// and prod (published DID) without re-consenting. Repo writes and blob uploads
// live as standalone scopes since they reference NSIDs (or resource kinds)
// outside the `rsvp.atmo` namespace.
export const scopes = [
	'atproto',
	scope.repo({ collection: [...collections] }),
	scope.blob({ accept: ['image/*'] }),
	'include:rsvp.atmo.permissionSet',
	'include:app.bsky.authCreatePosts',
	// atmo.pub notifications: lets us mint user tokens (via
	// com.atproto.server.getServiceAuth) to ask for/revoke notification consent.
	// `send` itself needs no user scope (it's signed with our app key).
	'rpc?lxm=pub.atmo.notify.requestPermission&aud=*',
	'rpc?lxm=pub.atmo.notify.revokeSelf&aud=*',
	META_READ_GRANT,
	...GROUP_MEMBER_RPC_GRANTS
];

// set to false to disable signup
export const ALLOW_SIGNUP = true;

// which PDS to use for signup (change to your preferred PDS)
const devPDS = 'https://pds.rip/';
const prodPDS = 'https://selfhosted.social/';
export const signUpPDS = dev ? devPDS : prodPDS;

// where to redirect after oauth login/signup
export const REDIRECT_PATH = '/oauth/callback';

// where to redirect after a group's owner links the group's account. Its own
// path, because the sign-in callback signs the browser in as whoever authorized.
export const GROUP_LINK_REDIRECT_PATH = '/oauth/group-link/callback';

// redirect the user back to the page they were on before login
export const REDIRECT_TO_LAST_PAGE_ON_LOGIN = true;

export const DOH_RESOLVER = 'https://mozilla.cloudflare-dns.com/dns-query';

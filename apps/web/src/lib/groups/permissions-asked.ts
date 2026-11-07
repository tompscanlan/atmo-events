// Whether a person already asked for their group permissions from this browser, so a page can
// tell "not asked yet" from "asked, and their server did not grant them" (most servers cannot
// yet). A server cannot be told apart by asking it, so this remembers the ask instead. A cookie,
// so the server renders the right page; it holds only the person's DID.
import type { Cookies } from '@sveltejs/kit';

export const ASKED_COOKIE = 'atmo_group_permissions_asked';
const ASKED_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

/** In the browser, just before asking. */
export function markAsked(did: string): void {
	const secure = location.protocol === 'https:' ? '; Secure' : '';
	document.cookie = `${ASKED_COOKIE}=${encodeURIComponent(did)}; Path=/; Max-Age=${ASKED_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

/** Once the grants are held. They can be lost again, since a later plain sign-in replaces them, and
 *  that says nothing about their server, so they must be offered them again rather than told it can't. */
export function forgetAsked(cookies: Pick<Cookies, 'delete'>): void {
	cookies.delete(ASKED_COOKIE, { path: '/', secure: false, httpOnly: false });
}

/** `ask` offers the button, `refused` explains that the person's server did not grant them;
 *  null when there is nothing to ask for. */
export type GroupAccess = 'ask' | 'refused' | null;

export function groupAccess(
	askAccess: boolean,
	cookies: Pick<Cookies, 'get'>,
	did: string | null | undefined
): GroupAccess {
	if (!askAccess) return null;
	return did && cookies.get(ASKED_COOKIE) === did ? 'refused' : 'ask';
}

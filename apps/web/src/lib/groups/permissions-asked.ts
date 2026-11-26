// Whether a person just came back from asking for a group permission, to make groups or to join
// them, as private events tell it (lib/private-events/permissions-asked.ts): the ask comes back to the page with the
// person's DID in its address, and nothing is stored.
import { privateEventAccess } from '#lib/private-events/permissions-asked.js';

export { askedReturnTo } from '#lib/private-events/permissions-asked.js';

/** `ask` offers the button, `refused` says their server did not grant it. */
export type GroupAccess = 'ask' | 'refused';

export function groupAccess(url: URL, did: string): GroupAccess {
	return privateEventAccess(url, did);
}

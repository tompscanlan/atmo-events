// Links into a record browser (pds.ls on the public network, the network's own elsewhere: the
// PUBLIC_ATPROTO_PDSLS_URL setting), so anyone can read the record a group page describes straight
// from the PDS that holds it. The browser takes the at:// URI as its path, for an account, a record,
// a space or a record in a space (`spaceRecordUri`) alike. A space's contents open only for a viewer
// signed in to it with an account the space admits.
import { network } from '$lib/atproto/network';

/** The record browser's page for an at:// URI, or for a bare DID's repo; null when there is none. */
export function pdslsUrl(target: string, base = network().pdslsUrl): string | null {
	if (!base) return null;
	return `${base}/${target.startsWith('at://') ? target : `at://${target}`}`;
}

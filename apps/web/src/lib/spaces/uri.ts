// Addresses in a space, as the permissioned data proposal writes them. Values only, so pages can
// import them.

/** A space's URI, in the form a PDS on the spaces alpha of 24 November 2026 takes, and the only one
 *  written: `at:space/<authority>/<type>/<key>`. */
export function spaceUri(authority: string, type: string, key: string): string {
	return `at:space/${authority}/${type}/${key}`;
}

/** A space record's URI, in the form `getRecord` returns. */
export function spaceRecordUri(
	space: string,
	repo: string,
	collection: string,
	rkey: string
): string {
	return `${space}/${repo}/${collection}/${rkey}`;
}

/** A space's or a space record's URI in the `at:space/` form, so either form compares as the same.
 *  One in the older form, `at://<authority>/space/<type>/<key>…`, is rewritten: deprecated, it is
 *  only read, from what was written before, and never written. Anything else is left as it is. */
export function currentSpaceUri(uri: string): string {
	const older = /^at:\/\/([^/]+)\/space\/(.+)$/.exec(uri);
	return older ? `at:space/${older[1]}/${older[2]}` : uri;
}

/** The authority and key of a space URI, in either form; null for anything else. */
export function parseSpaceUri(
	uri: string
): { authority: string; type: string; key: string } | null {
	const match = /^at:space\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(currentSpaceUri(uri));
	return match ? { authority: match[1], type: match[2], key: match[3] } : null;
}

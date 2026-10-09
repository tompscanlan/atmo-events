/** The handle label for a group, the leaf of `<label>.<GROUP_HANDLE_DOMAIN>`. It is
 *  the only name a group reserves. Lossy: non-ASCII names collapse to empty. It never
 *  truncates or invents a fallback, because the handle is a permanent reservation. An
 *  empty return means "ask the user". */
export function labelFromGroupName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** The create form's first check of a label's shape. It is looser than
 *  `labelMintRefusal`, which runs next and says exactly what the PDS would
 *  refuse. */
export const GROUP_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** The PDS's handle-label bounds (`ensureHandleServiceConstraints` in the atproto PDS). */
export const MINTABLE_LABEL_MIN_LENGTH = 3;
export const MINTABLE_LABEL_MAX_LENGTH = 18;

/** The same bounds as an HTML `pattern`, so the form cannot drift from `labelMintRefusal`. */
export const MINTABLE_LABEL_INPUT_PATTERN = `[a-z0-9][a-z0-9-]{${MINTABLE_LABEL_MIN_LENGTH - 1},${MINTABLE_LABEL_MAX_LENGTH - 1}}`;

/** The PDS's `atpSpecific` reserved labels. Its ~1000 other reserved names are not
 *  mirrored, so a mint can still be refused as reserved. */
const ATP_RESERVED_LABELS: Record<string, true> = {
	at: true,
	atp: true,
	plc: true,
	pds: true,
	did: true,
	repo: true,
	tid: true,
	nsid: true,
	xrpc: true,
	lex: true,
	lexicon: true,
	bsky: true,
	bluesky: true,
	handle: true
};

/** The names of a group's own spaces, refused on the form before any PDS call. */
const APP_RESERVED_LABELS: Record<string, true> = { about: true, members: true };

export type LabelMintRefusal = 'characters' | 'too-short' | 'too-long' | 'reserved';

/** Why this label cannot be minted, or `null`. Checked in the PDS's order, so the
 *  first refusal is the one the PDS would give. */
export function labelMintRefusal(slug: string): LabelMintRefusal | null {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return 'characters';
	if (slug.length < MINTABLE_LABEL_MIN_LENGTH) return 'too-short';
	if (slug.length > MINTABLE_LABEL_MAX_LENGTH) return 'too-long';
	if (ATP_RESERVED_LABELS[slug] || APP_RESERVED_LABELS[slug]) return 'reserved';
	return null;
}

export function labelMintRefusalMessage(refusal: LabelMintRefusal, slug: string): string {
	switch (refusal) {
		case 'characters':
			return 'A group URL uses lowercase letters, numbers and hyphens, and starts with a letter or number.';
		case 'too-short':
			return `“${slug}” is too short for a group address. Use at least ${MINTABLE_LABEL_MIN_LENGTH} characters.`;
		case 'too-long':
			return `“${slug}” is ${slug.length} characters; a group address allows at most ${MINTABLE_LABEL_MAX_LENGTH}. Choose a shorter URL name.`;
		case 'reserved':
			return `“${slug}” is reserved and cannot be a group address. Choose another URL name.`;
	}
}

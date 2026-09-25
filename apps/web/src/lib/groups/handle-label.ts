/** The handle label for a group: the leaf of `<label>.<GROUP_HANDLE_DOMAIN>`
 *  (for example `kona.groups.example.com`), which is the only name a group
 *  reserves anywhere. There is no slug: the URL key is the group's DID and the
 *  displayed name is the profile record's, so this module guards the one string
 *  the PDS's handle registry will judge at mint.
 *
 *  Lossy on purpose: non-ASCII names collapse to empty, because a label is for
 *  a handle, not a faithful encoding of the name (the `profile` record holds
 *  that).
 *
 *  It does not truncate and does not invent a fallback. Registering the handle
 *  is the name reservation, so a mangled or invented label mints a permanent
 *  `did:plc` under a name nobody chose. An empty return means "ask the user",
 *  which is what the create form does. */
export function labelFromGroupName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** The widest label this app accepts in a form. Deliberately wider than the
 *  mint rules below: `labelMintRefusal` is what a new group is held to, and
 *  narrowing this to match would refuse labels a group may already hold, such
 *  as a handle minted before these bounds or one an imported group brought with
 *  it. It is a shape check on a string, never a lookup key: no column stores it. */
export const GROUP_LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** The PDS's handle-label bounds, copied from the atproto PDS
 *  (`packages/pds/src/handle/index.ts`, `ensureHandleServiceConstraints`). A
 *  group handle is `<label>.<GROUP_HANDLE_DOMAIN>`, so the label the PDS
 *  measures is exactly this string. */
export const MINTABLE_LABEL_MIN_LENGTH = 3;
export const MINTABLE_LABEL_MAX_LENGTH = 18;

/** The same bounds as an HTML `pattern` attribute, so the form's own validation
 *  cannot drift from `labelMintRefusal`. First character, then 2..17 more. */
export const MINTABLE_LABEL_INPUT_PATTERN = `[a-z0-9][a-z0-9-]{${MINTABLE_LABEL_MIN_LENGTH - 1},${MINTABLE_LABEL_MAX_LENGTH - 1}}`;

/** `atpSpecific` from `packages/pds/src/handle/reserved.ts`: the protocol's own
 *  reservations, which are stable and short enough to mirror.
 *
 *  The PDS also refuses about 1000 `commonlyReserved` and `famousAccounts`
 *  labels. Those are deliberately not copied here: a mirrored list of that size
 *  goes stale silently and would claim an authority we do not have. The PDS
 *  stays the authority, so a taken or reserved handle refused at mint must
 *  surface on the form as "that name is taken or reserved", never as a 500. */
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

/** Labels this app reserves: `about` and `members`, the names of a group's own
 *  spaces. `about` is also in the PDS's `commonlyReserved` list, so the PDS
 *  would refuse it at mint anyway. Listing both here refuses them on the form,
 *  before any PDS call, instead of with a generic reserved-handle error from a
 *  service the user never sees. */
const APP_RESERVED_LABELS: Record<string, true> = { about: true, members: true };

export type LabelMintRefusal = 'characters' | 'too-short' | 'too-long' | 'reserved';

/** Why this slug cannot be minted as a handle label, or `null` if it can.
 *
 *  Checked before any PDS call, so the refusal lands on the field the user can
 *  edit. The PDS checks characters, then length, then reserved names
 *  (`ensureHandleServiceConstraints`), and this follows the same order: a
 *  caller that reports the first refusal reports the one the PDS would. */
export function labelMintRefusal(slug: string): LabelMintRefusal | null {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return 'characters';
	if (slug.length < MINTABLE_LABEL_MIN_LENGTH) return 'too-short';
	if (slug.length > MINTABLE_LABEL_MAX_LENGTH) return 'too-long';
	if (ATP_RESERVED_LABELS[slug] || APP_RESERVED_LABELS[slug]) return 'reserved';
	return null;
}

/** The sentence the create form shows. Says what to do, and never blames the
 *  user for a rule that belongs to a service they cannot see. */
export function labelMintRefusalMessage(refusal: LabelMintRefusal, slug: string): string {
	switch (refusal) {
		case 'characters':
			return 'A group URL uses lowercase letters, numbers and hyphens, and starts with a letter or number.';
		case 'too-short':
			return `“${slug}” is too short for a group address — use at least ${MINTABLE_LABEL_MIN_LENGTH} characters.`;
		case 'too-long':
			return `“${slug}” is ${slug.length} characters; a group address allows at most ${MINTABLE_LABEL_MAX_LENGTH}. Choose a shorter URL name.`;
		case 'reserved':
			return `“${slug}” is reserved and cannot be a group address. Choose another URL name.`;
	}
}

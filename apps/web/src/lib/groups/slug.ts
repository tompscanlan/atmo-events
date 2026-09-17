/** URL slug for a group name. Lossy on purpose — non-ASCII names collapse to
 *  empty, because a slug is a handle for humans typing a URL, not a faithful
 *  encoding of the name (which lives in `groups.name`).
 *
 *  It does NOT truncate and it does NOT invent a fallback. Since FR-001a the
 *  slug's label is also the group's PDS handle, and the handle registration is
 *  the name reservation — so a mangled or invented label mints a permanent
 *  `did:plc` under a name nobody chose. An empty return means "ask the user",
 *  which is what the create form does. */
export function slugifyGroupName(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** What a slug ALREADY IN THE DATABASE may look like. `groups.slug` is
 *  `TEXT NOT NULL UNIQUE` with no length limit (migrations/0001_groups.sql:45),
 *  and legacy imports (`om-8oehw`) bring long slugs with them, so this pattern
 *  backs every form that addresses an existing group. Narrowing it to the mint
 *  rules below would make a member unable to leave, or an admin unable to
 *  approve, a group that already exists. Use `slugMintRefusal` for new ones. */
export const GROUP_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;

/** The PDS's handle-label bounds, copied from
 *  `atproto-permissioned-data/packages/pds/src/handle/index.ts`
 *  (`ensureHandleServiceConstraints`, read 2026-09-17 at the spaces-alpha
 *  branch). A group handle is `<slug>.group.opnmt.net`, so with that domain the
 *  label the PDS measures IS the slug. */
export const MINTABLE_LABEL_MIN_LENGTH = 3;
export const MINTABLE_LABEL_MAX_LENGTH = 18;

/** The same bounds as an HTML `pattern` attribute, so the form's own validation
 *  cannot drift from `slugMintRefusal`. First character, then 2..17 more. */
export const MINTABLE_LABEL_INPUT_PATTERN = `[a-z0-9][a-z0-9-]{${MINTABLE_LABEL_MIN_LENGTH - 1},${MINTABLE_LABEL_MAX_LENGTH - 1}}`;

/** `atpSpecific` from `packages/pds/src/handle/reserved.ts` — the protocol's own
 *  reservations, which are stable and short enough to mirror.
 *
 *  The PDS also refuses ~1000 `commonlyReserved` and `famousAccounts` labels.
 *  Those are deliberately NOT copied here: a mirrored list of that size goes
 *  stale silently and would claim an authority we do not have. The PDS stays the
 *  authority — a `HandleNotAvailable` at mint must surface on the form as
 *  "that name is taken or reserved", never as a 500. */
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

/** Our own space keys. `about` is in the PDS's `commonlyReserved` list anyway,
 *  so it would be refused at mint; naming both here means the refusal is
 *  explicable ("that is one of a group's own space names") instead of a generic
 *  reserved-handle error from a service the user never sees. */
const OPENMEET_RESERVED_LABELS: Record<string, true> = { about: true, members: true };

export type SlugMintRefusal = 'characters' | 'too-short' | 'too-long' | 'reserved';

/** Why this slug cannot be minted as a handle label, or `null` if it can.
 *
 *  Checked BEFORE any PDS call so the refusal lands on the field the user can
 *  edit. The PDS's own order is characters → length → reserved
 *  (`ensureHandleServiceConstraints`), and this mirrors it: a caller that
 *  reports the first refusal reports the same one the PDS would. */
export function slugMintRefusal(slug: string): SlugMintRefusal | null {
	if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return 'characters';
	if (slug.length < MINTABLE_LABEL_MIN_LENGTH) return 'too-short';
	if (slug.length > MINTABLE_LABEL_MAX_LENGTH) return 'too-long';
	if (ATP_RESERVED_LABELS[slug] || OPENMEET_RESERVED_LABELS[slug]) return 'reserved';
	return null;
}

/** The sentence the create form shows. Says what to do, and never blames the
 *  user for a rule that belongs to a service they cannot see. */
export function slugMintRefusalMessage(refusal: SlugMintRefusal, slug: string): string {
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

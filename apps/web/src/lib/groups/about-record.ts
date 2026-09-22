// A group's PUBLIC FACE as records: the profile, and one record per rule.
//
// Today a group's name and description are D1 columns, so a peer app can read
// the group's DID and nothing else — it cannot render the group's name. These
// two record classes are what fix that: the columns become a cache of records
// that live in the group's own about space, under the group's own DID.
//
// Pure, like ./event-record.ts: shape only, no D1 and no PDS. Permission,
// authorship and transport live in ./server/about-writer.ts, and reading them
// back lives in ./server/about-read.ts. Splitting it this way is what lets the
// builders and the parsers be asserted without a request, and it is why the
// live probe drives these exact functions rather than a copy.
//
// WHY THE NAMES ARE OURS. The draft these records come from calls them
// `community.opensocial.profile` and `.rule`, and we deliberately do not write
// under that prefix: it resolves to a domain someone else holds, and a
// same-named live service is already publishing unrelated record schemas there.
// Ours sit under a domain we hold, with the LEAVES matching the draft, so if the
// standard settles the migration is a prefix change plus a record replay rather
// than a reshape. Every collection string below is in exactly one place for
// that reason. (The two-project measurement is in the spec kit's contracts
// ledger; the naming rule is the record half of the same decision that gave
// `net.openmeet.space.*` its prefix — see ./types.ts.)

/** Both collections, and both only here. A prefix change is one edit. */
export const GROUP_PROFILE_COLLECTION = 'net.openmeet.group.profile';
export const GROUP_RULE_COLLECTION = 'net.openmeet.group.rule';

/** The profile is a singleton, keyed like every other atproto profile record
 *  (`app.bsky.actor.profile/self`). Rules are keyed by TID: one rule per record
 *  so a moderation action can cite a stable URI for the rule it enforced. */
export const GROUP_PROFILE_RKEY = 'self';

/** How a stranger gets in. This is the draft's `profile.joinPolicy`, and it is
 *  the only part of our `visibility` / `require_approval` pair that belongs on
 *  the profile — who may READ a space is the `access` record's job, not the
 *  profile's. */
export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];

function isJoinPolicy(value: unknown): value is GroupJoinPolicy {
	return typeof value === 'string' && (GROUP_JOIN_POLICIES as readonly string[]).includes(value);
}

/** The cache columns the profile record is authoritative for. */
export interface GroupProfileFields {
	name: string;
	description: string | null;
	joinPolicy: GroupJoinPolicy;
	/** OUR EXTENSION, not in the draft — see `groupProfileRecord`. */
	locationName: string | null;
	/** So an edit can re-send the original rather than restamping the group's
	 *  creation date. `null` for a record written without one. */
	createdAt: string | null;
}

/** `visibility` + `require_approval` -> the one join policy they encode.
 *
 *  A private group is invite-only by construction (migrations/
 *  0003_private_groups_are_invite_only.sql refuses a self-service join on one),
 *  so `private` decides the policy before `require_approval` is consulted. */
export function joinPolicyFor(group: {
	visibility: string;
	require_approval: number;
}): GroupJoinPolicy {
	if (group.visibility === 'private') return 'invite';
	return group.require_approval ? 'approval' : 'open';
}

/** The inverse, for the rebuild path — and it is deliberately PARTIAL even
 *  though it no longer has to be.
 *
 *  `require_approval` round-trips. `visibility` is now encodable in principle:
 *  with two values the forward map is total, so `invite` could only have come
 *  from `private` and everything else from `public`. We still do NOT invert it,
 *  because reading `private` back out of `invite` would weld the two together
 *  permanently and forbid a public group from ever being invite-only — a
 *  restriction the join policy is meant to express, not the visibility
 *  (FR-004b). Read access is the `access` record's business and that record is
 *  a separate bead, so a rebuild must NOT guess a visibility from a profile.
 *  `about-read.ts` keeps the stored one and fails closed to `private` when
 *  there is no row at all. */
export function requireApprovalFor(policy: GroupJoinPolicy): number {
	return policy === 'open' ? 0 : 1;
}

export interface GroupProfileInput {
	name: string;
	description?: string | null;
	joinPolicy: GroupJoinPolicy;
	locationName?: string | null;
	/** Preserved across an edit so editing a group does not restamp the record. */
	createdAt?: string;
}

/**
 * The profile record.
 *
 * `displayName` / `description` / `joinPolicy` are the draft's own fields.
 *
 * `location` IS AN EXTENSION AND IS MARKED AS ONE HERE, because the draft's
 * profile has no location of any kind, and an undeclared extra field is how a
 * local convention quietly becomes a fork. Only the NAME is carried: the
 * remaining four location columns (address, lat, lng, timezone) are not written,
 * so they are cache that no record can rebuild — a deliberate, documented gap
 * rather than an invented lexicon, because nothing reads them today (lat/lng are
 * never even updatable) and a group location that needs geocoding is atmo's
 * near-me path, not this iteration's.
 *
 * `avatar` is also absent: the draft has it, we have `image_cid`/`image_mime`,
 * and moving a blob between repos is its own problem. Named so the omission
 * reads as a decision.
 *
 * (Spec: FR-004a for the location extension, FR-004d for the avatar.)
 */
export function groupProfileRecord(input: GroupProfileInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	const record: Record<string, unknown> = {
		displayName: input.name,
		joinPolicy: input.joinPolicy,
		createdAt: input.createdAt || new Date().toISOString()
	};
	const description = input.description?.trim();
	if (description) record.description = description;
	const location = input.locationName?.trim();
	if (location) record.location = { name: location };
	return record;
}

/** A profile record -> the cache fields, or null when the value is not a
 *  profile at all. Tolerant on purpose: a record written by an older build must
 *  still render, so only `displayName` is required and an unknown `joinPolicy`
 *  degrades to the safest reading (`invite`) rather than throwing a page away. */
export function parseGroupProfile(value: unknown): GroupProfileFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;

	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	// Narrowed with `in`/`typeof` rather than asserted: this value came off a PDS
	// and an older build may have written anything under `location`.
	let locationName: string | null = null;
	const location = raw.location;
	if (location && typeof location === 'object' && 'name' in location) {
		const candidate = location.name;
		if (typeof candidate === 'string') locationName = candidate.trim() || null;
	}

	return {
		name,
		description: description || null,
		joinPolicy: isJoinPolicy(raw.joinPolicy) ? raw.joinPolicy : 'invite',
		locationName,
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

export interface GroupRuleFields {
	text: string;
	/** OUR EXTENSION — see `groupRuleRecord`. */
	order: number;
	createdAt: string | null;
}

export interface GroupRuleInput {
	text: string;
	order: number;
	createdAt?: string;
}

/**
 * One rule.
 *
 * `order` IS AN EXTENSION AND IS MARKED AS ONE, on the draft's own terms: it
 * says ordering is not specified and that if we need order it is ours to add and
 * must be declared. We need it — a rules list that reshuffles between page loads
 * is not a rules list — so it is here, as an integer, and a reader that does not
 * know the field simply gets an unordered set, which is what the draft promises.
 *
 * (Spec: FR-004c.)
 */
export function groupRuleRecord(input: GroupRuleInput): Record<string, unknown> {
	return {
		text: input.text.trim(),
		order: input.order,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

export function parseGroupRule(value: unknown): GroupRuleFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const text = typeof raw.text === 'string' ? raw.text.trim() : '';
	if (!text) return null;
	return {
		text,
		order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0,
		createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null
	};
}

/** The rules textarea -> one trimmed rule per non-empty line.
 *
 *  A textarea rather than a repeater because a rule is a sentence, the order is
 *  the line order, and this keeps the form a single field while the records
 *  stay one-per-rule underneath. Blank lines are separators, not rules. */
export function splitRuleLines(value: string | null | undefined): string[] {
	if (!value) return [];
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

// A group's public face as records: the profile, and one record per rule.
//
// Without these records a peer app could read a group's DID and nothing else,
// so it could not show the group's name. They live in the group's own about
// space, under the group's own DID, and the D1 name and description columns
// are a cache of them.
//
// Pure, like ./event-record.ts: shape only, no D1 and no PDS, so the builders
// and parsers can be tested without a request. Permission, authorship and
// transport live in ./server/about-writer.ts; reading them back lives in
// ./server/about-read.ts.
//
// WHY THE NAMES ARE OURS. The draft these records come from calls them
// `community.opensocial.profile` and `.rule`. We do not write under that
// prefix: it resolves to a domain someone else holds, and a live service with
// the same name already publishes unrelated record schemas there. Ours sit
// under a domain we hold, with leaves that match the draft, so if the standard
// settles, migrating is a prefix change plus a record replay, not a reshape.
// That is why every collection string below is in exactly one place. The same
// rule gave `net.openmeet.space.*` its prefix (see ./types.ts).

/** Both collections, and both only here. A prefix change is one edit. */
export const GROUP_PROFILE_COLLECTION = 'net.openmeet.group.profile';
export const GROUP_RULE_COLLECTION = 'net.openmeet.group.rule';

/** The profile is a singleton, keyed like every other atproto profile record
 *  (`app.bsky.actor.profile/self`). Rules are keyed by TID: one rule per record
 *  so a moderation action can cite a stable URI for the rule it enforced. */
export const GROUP_PROFILE_RKEY = 'self';

/** How a stranger gets in. This is the draft's `profile.joinPolicy`, and it is
 *  the only part of our `visibility` / `require_approval` pair that belongs on
 *  the profile. Who may read a space is the `access` record's job, not the
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
	/** Our extension, not in the draft. See `groupProfileRecord`. */
	locationName: string | null;
	/** So an edit can re-send the original rather than restamping the group's
	 *  creation date. `null` for a record written without one. */
	createdAt: string | null;
}

/** `visibility` + `require_approval` -> the one join policy they encode.
 *
 *  A private group is invite-only (migrations/0001_groups.sql refuses a private
 *  group that does not require approval), so `private` decides the policy
 *  before `require_approval` is consulted. */
export function joinPolicyFor(group: {
	visibility: string;
	require_approval: number;
}): GroupJoinPolicy {
	if (group.visibility === 'private') return 'invite';
	return group.require_approval ? 'approval' : 'open';
}

/** A group's public face, from its profile record when there is one and from
 *  the row only when there is not. The branch is taken once, on the record's
 *  presence, never per field: a record's `null` is an authored value (this
 *  group has no description) and must win over whatever the row still holds.
 *  A per-field `??` cannot tell that from absence, and would let a stale row
 *  leak into a page that reports `records`. `source` says which one rendered,
 *  so a browser can see whether the page came from records. */
export function groupFace(
	profile: GroupProfileFields | null,
	group: {
		name: string;
		description: string | null;
		location_name: string | null;
		visibility: string;
		require_approval: number;
	}
): {
	source: 'records' | 'cache';
	name: string;
	description: string | null;
	locationName: string | null;
	joinPolicy: GroupJoinPolicy;
} {
	if (profile) {
		return {
			source: 'records',
			name: profile.name,
			description: profile.description,
			locationName: profile.locationName,
			joinPolicy: profile.joinPolicy
		};
	}
	return {
		source: 'cache',
		name: group.name,
		description: group.description,
		locationName: group.location_name,
		joinPolicy: joinPolicyFor(group)
	};
}

/** The inverse, for the rebuild path. It is partial on purpose.
 *
 *  `require_approval` round-trips. `visibility` could be inverted (with two
 *  values, `invite` can only come from `private`), but it is not: reading
 *  `private` back out of `invite` would tie the two together for good and
 *  forbid a public group from ever being invite-only. That is a restriction the
 *  join policy should express, not the visibility. So a rebuild must not guess
 *  a visibility from a profile. A repair keeps the stored one; a group with no
 *  row at all takes it from whether its public repo declares it
 *  (`server/rebuild.ts`). */
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
 * `displayName`, `description` and `joinPolicy` are the draft's own fields.
 *
 * `location` is an extension, and is marked as one here, because the draft's
 * profile has no location of any kind, and an undeclared extra field is how a
 * local convention quietly becomes a fork. Only the location name is carried.
 *
 * `avatar` is also absent: the draft has it, we have `image_cid`/`image_mime`,
 * and moving a blob between repos is its own problem.
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
 *  still render, so only `displayName` is required, and an unknown `joinPolicy`
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
	/** Our extension. See `groupRuleRecord`. */
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
 * `order` is an extension, and is marked as one, on the draft's own terms: the
 * draft leaves ordering unspecified and says an app that needs order must add
 * and declare it. We need it (a rules list that reshuffles between page loads is
 * not a rules list), so it is here as an integer. A reader that does not know
 * the field gets an unordered set, which is what the draft promises.
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

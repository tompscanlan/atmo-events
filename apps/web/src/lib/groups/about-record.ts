// A group's public face as records, in its about space: the profile, and one record
// per rule. The D1 name and description columns are a cache of them.
// The names are ours, not the draft's `community.opensocial.*`: that prefix resolves
// to a domain someone else holds, where a live service publishes unrelated schemas.
// The leaves match the draft, so a settled standard is a prefix change plus a record
// replay. The same holds for every group collection and space type.
import type { GroupVisibility } from './types';

export const GROUP_PROFILE_COLLECTION = 'net.openmeet.group.profile';
export const GROUP_RULE_COLLECTION = 'net.openmeet.group.rule';

/** A singleton. Rules are keyed by TID, so a moderation action can cite one rule. */
export const GROUP_PROFILE_RKEY = 'self';

/** The draft's `profile.joinPolicy`. Who may read the space is not the profile's job. */
export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];

function isJoinPolicy(value: unknown): value is GroupJoinPolicy {
	return typeof value === 'string' && (GROUP_JOIN_POLICIES as readonly string[]).includes(value);
}

export const PRIVATE_NEEDS_APPROVAL =
	'A private group must require approval to join. Invite members instead.';

/** The refusal for a private group that anyone may join, or null. Checked in app
 *  code before the first write, because visibility lives at the host, where no SQL
 *  constraint can see it. An absent `requireApproval` means approval on. */
export function approvalRefusal(
	visibility: GroupVisibility,
	requireApproval: boolean | undefined
): string | null {
	return visibility === 'private' && requireApproval === false ? PRIVATE_NEEDS_APPROVAL : null;
}

/** The cache columns the profile record is authoritative for. */
export interface GroupProfileFields {
	name: string;
	description: string | null;
	joinPolicy: GroupJoinPolicy;
	locationName: string | null;
	createdAt: string | null;
}

/** A visibility and an approval setting -> the join policy they encode. Anything but
 *  `public`, including `null` for a host nobody could ask, is invite-only. */
export function joinPolicyFor(
	visibility: GroupVisibility | null,
	requireApproval: number | boolean
): GroupJoinPolicy {
	if (visibility !== 'public') return 'invite';
	return requireApproval ? 'approval' : 'open';
}

/** A group's public face, from its profile record when there is one and from the row
 *  only when there is not. The branch is taken once, not per field, because a
 *  record's `null` is an authored value that must win over the row. The join policy
 *  is derived from the host's visibility on both branches, since any client can
 *  change the host's read policy without touching our records. */
export function groupFace(
	profile: GroupProfileFields | null,
	group: {
		name: string;
		description: string | null;
		location_name: string | null;
		require_approval: number;
	},
	visibility: GroupVisibility | null
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
			joinPolicy: visibility === 'public' ? profile.joinPolicy : 'invite'
		};
	}
	return {
		source: 'cache',
		name: group.name,
		description: group.description,
		locationName: group.location_name,
		joinPolicy: joinPolicyFor(visibility, group.require_approval)
	};
}

/** The inverse, for the rebuild path. Visibility is not inverted: `invite` must not
 *  imply `private`, and a rebuild never writes the host's read policy. */
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

/** `displayName`, `description` and `joinPolicy` are the draft's fields. `location`
 *  is our extension. There is no `avatar`: moving a blob between repos is its own problem. */
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

/** A profile record -> the cache fields, or null when it is not a profile. Tolerant,
 *  since an older build may have written it: an unknown `joinPolicy` reads as `invite`. */
export function parseGroupProfile(value: unknown): GroupProfileFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;

	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
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
	order: number;
	createdAt: string | null;
}

export interface GroupRuleInput {
	text: string;
	order: number;
	createdAt?: string;
}

/** One rule. `order` is our extension: the draft leaves ordering to an app that needs
 *  it, and a reader that does not know the field gets an unordered set. */
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

/** The rules textarea -> one trimmed rule per non-empty line, in line order. */
export function splitRuleLines(value: string | null | undefined): string[] {
	if (!value) return [];
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

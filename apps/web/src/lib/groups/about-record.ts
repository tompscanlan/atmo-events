// The profile and one record per rule, in the meta space; the row's name and
// description are a cache of them.
export const GROUP_PROFILE_COLLECTION = 'group.opensocial.profile';
export const GROUP_RULE_COLLECTION = 'group.opensocial.rule';
export const GROUP_PROFILE_RKEY = 'self';

export const GROUP_JOIN_POLICIES = ['open', 'approval', 'invite'] as const;
export type GroupJoinPolicy = (typeof GROUP_JOIN_POLICIES)[number];

function isJoinPolicy(value: unknown): value is GroupJoinPolicy {
	return typeof value === 'string' && (GROUP_JOIN_POLICIES as readonly string[]).includes(value);
}

export const GROUP_NAME_MAX = 64;
export const GROUP_DESCRIPTION_MAX = 2000;
export const GROUP_RULE_MAX = 2000;

export interface GroupProfileFields {
	name: string;
	description: string | null;
	joinPolicy: GroupJoinPolicy;
	record: Record<string, unknown>;
}

/** A record's `null` is authored, so the row stands in only when there is no record. */
export function groupFace(
	profile: GroupProfileFields | null,
	group: { name: string; description: string | null }
): { name: string; description: string | null; joinPolicy: GroupJoinPolicy | null } {
	if (profile) {
		return { name: profile.name, description: profile.description, joinPolicy: profile.joinPolicy };
	}
	return { name: group.name, description: group.description, joinPolicy: null };
}

export interface GroupProfileInput {
	name: string;
	description?: string | null;
	joinPolicy: GroupJoinPolicy;
	/** The record as read, whose other fields (`avatar`, `banner`, `url`) are kept. */
	base?: Record<string, unknown>;
}

export function groupProfileRecord(input: GroupProfileInput): Record<string, unknown> {
	const record: Record<string, unknown> = {
		...input.base,
		displayName: input.name,
		joinPolicy: input.joinPolicy
	};
	delete record.$type;
	const description = input.description?.trim();
	if (description) record.description = description;
	else delete record.description;
	return record;
}

/** An unknown `joinPolicy` reads as `invite`, the most closed. */
export function parseGroupProfile(value: unknown): GroupProfileFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const name = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
	if (!name) return null;
	const description = typeof raw.description === 'string' ? raw.description.trim() : '';
	return {
		name,
		description: description || null,
		joinPolicy: isJoinPolicy(raw.joinPolicy) ? raw.joinPolicy : 'invite',
		record: raw
	};
}

export interface GroupRuleFields {
	text: string;
	order: number;
}

const RULE_TITLE_MAX_GRAPHEMES = 64;
const RULE_TITLE_MAX_BYTES = 640;

const graphemes = new Intl.Segmenter();
const utf8 = new TextEncoder();

// The lexicon requires a title and a rule here is one line, so the title is the
// line's first 64 graphemes, stopping before 640 bytes.
function ruleTitle(text: string): string {
	let title = '';
	let size = 0;
	let count = 0;
	for (const { segment } of graphemes.segment(text)) {
		const next = utf8.encode(segment).length;
		if (count === RULE_TITLE_MAX_GRAPHEMES || size + next > RULE_TITLE_MAX_BYTES) break;
		title += segment;
		size += next;
		count += 1;
	}
	return title;
}

export function groupRuleRecord(input: GroupRuleFields): Record<string, unknown> {
	const text = input.text.trim();
	return { title: ruleTitle(text), text, order: input.order };
}

export function parseGroupRule(value: unknown): GroupRuleFields | null {
	if (!value || typeof value !== 'object') return null;
	const raw = value as Record<string, unknown>;
	const text = typeof raw.text === 'string' ? raw.text.trim() : '';
	if (!text) return null;
	return {
		text,
		order: typeof raw.order === 'number' && Number.isFinite(raw.order) ? raw.order : 0
	};
}

export function splitRuleLines(value: string | null | undefined): string[] {
	if (!value) return [];
	return value
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function graphemeLength(value: string): number {
	return [...graphemes.segment(value)].length;
}

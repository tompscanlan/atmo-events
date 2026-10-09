// Writes a group's profile, rules and access record into its about space, through
// the event writer's gate and transport. The permission is always MANAGE_GROUP.
//
// A rule must stay citable by URI, so a moderation action can name the rule it
// enforced. So rules are matched by text rather than rewritten: an unchanged
// rule keeps its URI, a removed one is deleted and a new one is created.
import { now as tidNow } from '@atcute/tid';
import {
	GROUP_PROFILE_COLLECTION,
	GROUP_PROFILE_RKEY,
	GROUP_RULE_COLLECTION,
	groupProfileRecord,
	groupRuleRecord,
	joinPolicyFor,
	type GroupProfileInput
} from '../about-record';
import {
	ABOUT_SPACE_READER_ROLES,
	GROUP_ACCESS_COLLECTION,
	GROUP_ACCESS_RKEY,
	groupAccessRecord
} from '../members-record';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';

import type { GroupRuleRecord, GroupSpaceReader } from './about-read';

import {
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter
} from './group-write';
import { type CredentialStoreEnv } from './session';
export interface WriteGroupAboutInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	callerDid: string | null;
	writer?: GroupRepoWriter;
	reader?: GroupSpaceReader | null;
}

export interface ProfileWriteResult {
	uri: string;
	cid: string;
}

/** Read off the row, not computed: NULL means provisioning did not finish, and
 *  a write must not target a space the PDS has never heard of. A row made before
 *  the space type changed names a space of the old type, and is refused too, so
 *  no record lands where no reader looks. */
export function aboutSpace(group: GroupRow): string {
	const space = group.about_space_uri;
	if (!space) {
		throw new GroupRecordError(
			`${group.group_did} has no about space yet, so its profile cannot be written`
		);
	}
	if (!space.startsWith(`at://${group.group_did}/space/${ABOUT_SPACE_TYPE}/`)) {
		throw new GroupRecordError(`${space} is not ${group.group_did}'s about space`);
	}
	return space;
}

/** Puts the group's one `profile` record, keyed `self`. The caller passes the
 *  existing `createdAt`, so an edit keeps the creation date. */
export async function writeGroupProfile(
	input: WriteGroupAboutInput & {
		visibility: GroupVisibility;
		profile: Omit<GroupProfileInput, 'joinPolicy'> & {
			joinPolicy?: GroupProfileInput['joinPolicy'];
		};
	}
): Promise<ProfileWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const record = {
		...groupProfileRecord({
			...input.profile,
			// Derived unless passed, so a private group's profile says invite-only.
			joinPolicy:
				input.profile.joinPolicy ?? joinPolicyFor(input.visibility, input.group.require_approval)
		}),
		$type: GROUP_PROFILE_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY,
		record,
		intent: 'update',
		space: aboutSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

/** Puts the about space's `access` record, which says the group's visibility. The
 *  host enforces the space's read policy, not this record, so the record follows
 *  the policy and is never read to set it. A group with a declaration must have
 *  an access record that says public, so this is written before a declaration
 *  is published and after one is withdrawn. Idempotent, keyed `self`. */
export async function writeAboutAccess(
	input: WriteGroupAboutInput & { visibility: GroupVisibility }
): Promise<{ uri: string; cid: string }> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const record = {
		...groupAccessRecord({
			roles: ABOUT_SPACE_READER_ROLES,
			public: input.visibility === 'public'
		}),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_ACCESS_COLLECTION,
		rkey: GROUP_ACCESS_RKEY,
		record,
		intent: 'update',
		space: aboutSpace(input.group)
	});
	return { uri: result.uri, cid: result.cid };
}

export interface RulesWriteResult {
	/** Rules that already existed with this exact text, URI untouched. */
	kept: GroupRuleRecord[];
	created: { rkey: string; uri: string; text: string }[];
	deleted: { rkey: string; text: string }[];
}

/**
 * Reconciles the rule records against `desired`. Duplicate text collapses into
 * one rule. `existing` is passed in, so a test can supply it directly.
 */
export async function setGroupRules(
	input: WriteGroupAboutInput & { desired: string[]; existing: GroupRuleRecord[] }
): Promise<RulesWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');
	const space = aboutSpace(input.group);
	const writer = input.writer ?? (await groupWriter(input.env, input.group));

	const desired: string[] = [];
	const seen = new Set<string>();
	for (const text of input.desired) {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		desired.push(trimmed);
	}

	// First wins, so a rule stored twice loses the duplicate on the next save.
	const byText = new Map<string, GroupRuleRecord>();
	for (const rule of input.existing) {
		if (!byText.has(rule.text)) byText.set(rule.text, rule);
	}

	const result: RulesWriteResult = { kept: [], created: [], deleted: [] };
	const claimed = new Set<string>();

	for (const [index, text] of desired.entries()) {
		const match = byText.get(text);
		if (match) {
			claimed.add(match.rkey);
			// A rule that only moved is rewritten in place and keeps its URI. That is
			// why the order lives on the record, not in the rkey.
			if (match.order !== index) {
				await writer({
					repo: input.group.group_did,
					collection: GROUP_RULE_COLLECTION,
					rkey: match.rkey,
					record: {
						...groupRuleRecord({ text, order: index, createdAt: match.createdAt ?? undefined }),
						$type: GROUP_RULE_COLLECTION
					},
					intent: 'update',
					space
				});
			}
			result.kept.push({ ...match, order: index });
			continue;
		}

		const rkey = tidNow();
		const written = await writer({
			repo: input.group.group_did,
			collection: GROUP_RULE_COLLECTION,
			rkey,
			record: { ...groupRuleRecord({ text, order: index }), $type: GROUP_RULE_COLLECTION },
			intent: 'create',
			space
		});
		result.created.push({ rkey, uri: written.uri, text });
	}

	for (const rule of input.existing) {
		if (claimed.has(rule.rkey)) continue;
		await writer({
			repo: input.group.group_did,
			collection: GROUP_RULE_COLLECTION,
			rkey: rule.rkey,
			record: {},
			intent: 'delete',
			space
		});
		result.deleted.push({ rkey: rule.rkey, text: rule.text });
	}

	return result;
}

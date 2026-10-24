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
	groupAccessRecord,
	accessSays,
	type GroupAccessFields
} from '../members-record';
import { ABOUT_SPACE_TYPE, type GroupRow, type GroupVisibility } from '../types';

import type { GroupRuleRecord, GroupSpaceReader } from './about-read';

import { gatedWriter, requireGroupWrite, type GroupRepoWriter, ownSpace } from './group-write';
import { VISIBILITY_WRITE, spaceWrite } from '../grants';
import type { RoleGrant, WriteAction } from '../scopes';

const aboutSpace = (group: GroupRow) =>
	ownSpace(group, 'about', group.about_space_uri, 'its profile cannot be written');
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

/** Puts the group's one `profile` record, keyed `self`. The caller passes the
 *  existing `createdAt`, so an edit keeps the creation date. */
export async function writeGroupProfile(
	input: WriteGroupAboutInput & {
		visibility: GroupVisibility;
		profile: Omit<GroupProfileInput, 'joinPolicy'>;
	}
): Promise<ProfileWriteResult> {
	await requireGroupWrite(input, spaceWrite(ABOUT_SPACE_TYPE, GROUP_PROFILE_COLLECTION, 'update'));

	const record = {
		...groupProfileRecord({
			...input.profile,
			// Derived, so a private group's profile says invite-only.
			joinPolicy: joinPolicyFor(input.visibility, input.group.require_approval)
		}),
		$type: GROUP_PROFILE_COLLECTION
	};

	const writer = await gatedWriter(input);
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

/** Puts the about space's `access` record, which is the group's visibility. The
 *  host enforces it for every reader (./spaces.ts). A group with a declaration
 *  must have an access record that says
 *  public, so this is written before a declaration is published and after one
 *  is withdrawn. Idempotent, keyed `self`. `grants`, when the record already has
 *  some, are kept as they are and only `public` changes: a group host writes the
 *  record at create in its own roles, which this app's defaults would not name.
 *  (Spec: FR-214.) */
export async function writeAboutAccess(
	input: WriteGroupAboutInput & { visibility: GroupVisibility; grants?: readonly RoleGrant[] }
): Promise<{ uri: string; cid: string }> {
	await requireGroupWrite(input, VISIBILITY_WRITE);

	const isPublic = input.visibility === 'public';
	const record = {
		...(input.grants?.length
			? { public: isPublic, grants: input.grants.map(({ role, scopes }) => ({ role, scopes })) }
			: groupAccessRecord({
					spaceType: ABOUT_SPACE_TYPE,
					roles: ABOUT_SPACE_READER_ROLES,
					public: isPublic
				})),
		$type: GROUP_ACCESS_COLLECTION
	};

	const writer = await gatedWriter(input);
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

/** Writes the about space's access record when `current`, as read, does not
 *  already say `visibility`, and answers whether it wrote. The grants `current`
 *  holds are kept. */
export async function alignAboutAccess(
	input: WriteGroupAboutInput & { visibility: GroupVisibility },
	current: GroupAccessFields | null
): Promise<boolean> {
	if (accessSays(current, input.visibility === 'public')) return false;
	await writeAboutAccess({ ...input, grants: current?.grants });
	return true;
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
	const space = aboutSpace(input.group);

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

	// Each kind of write the save makes, checked before any is sent.
	const needs = new Set<WriteAction>();
	const matched = new Set<string>();
	for (const [index, text] of desired.entries()) {
		const match = byText.get(text);
		if (!match) needs.add('create');
		else {
			matched.add(match.rkey);
			if (match.order !== index) needs.add('update');
		}
	}
	if (input.existing.some((rule) => !matched.has(rule.rkey))) needs.add('delete');
	for (const action of needs) {
		await requireGroupWrite(input, spaceWrite(ABOUT_SPACE_TYPE, GROUP_RULE_COLLECTION, action));
	}
	const writer = await gatedWriter(input);

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

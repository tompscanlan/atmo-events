// Writing a group's public face (profile and rules) into its about space.
//
// The transport, credential and permission check are the event gate's
// (`groupWriter` and `requireGroupPermission` in ./event-writer.ts). What
// differs: the target is the about space, not the public repo (`repo` stays the
// group DID; the space scopes access, it does not reparent); the permission is
// always MANAGE_GROUP, with no intent to map; and rules are a set of records,
// so saving them is a reconcile rather than a put.
//
// THE RECONCILE. A rule must stay citable by URI, so a moderation action can
// say which rule it enforced. Deleting and re-creating the whole list would
// break every citation on every edit. So rules are matched by text: an
// unchanged rule keeps its TID and URI, a removed rule is deleted, and a new
// rule is created.
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
import type { GroupRow } from '../types';
import type { CredentialStoreEnv } from './credentials';
import {
	GroupRecordError,
	groupWriter,
	requireGroupPermission,
	type GroupRepoWriter
} from './event-writer';
import type { GroupRuleRecord, GroupSpaceReader } from './about-read';

export interface WriteGroupAboutInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Overrides the PDS transport. When absent, it is built from the group's
	 *  stored credential. */
	writer?: GroupRepoWriter;
	/** Overrides the members-space reader the gate resolves from. */
	reader?: GroupSpaceReader | null;
}

export interface ProfileWriteResult {
	uri: string;
	cid: string;
}

/** `at://<group did>/space/<type>/self`, the space every about record lands in.
 *
 *  Read off the row rather than recomputed, because a NULL here is a real state:
 *  a group whose provisioning did not finish has no space to write into, and
 *  saying so is better than writing to a URI the PDS has never heard of. */
function aboutSpace(group: GroupRow): string {
	if (!group.about_space_uri) {
		throw new GroupRecordError(
			`${group.group_did} has no about space yet, so its profile cannot be written`
		);
	}
	return group.about_space_uri;
}

/** Writes the group's `profile` record. Keyed `self`, so this is a put whether
 *  the group is new or being edited: there is exactly one profile.
 *
 *  `createdAt` is threaded from the existing record when there is one, so an
 *  edit does not restamp the group's creation date. The caller supplies it
 *  because only the caller knows whether it already read the record. */
export async function writeGroupProfile(
	input: WriteGroupAboutInput & {
		profile: Omit<GroupProfileInput, 'joinPolicy'> & {
			joinPolicy?: GroupProfileInput['joinPolicy'];
		};
	}
): Promise<ProfileWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');

	const record = {
		...groupProfileRecord({
			...input.profile,
			// Unless the caller passes one, the join policy is derived from the
			// row: `visibility` + `require_approval` are what the schema enforces
			// (migrations/0001_groups.sql makes a private group require approval),
			// so the record matches the row.
			joinPolicy: input.profile.joinPolicy ?? joinPolicyFor(input.group)
		}),
		$type: GROUP_PROFILE_COLLECTION
	};

	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));
	const result = await writer({
		repo: input.group.group_did,
		collection: GROUP_PROFILE_COLLECTION,
		rkey: GROUP_PROFILE_RKEY,
		record,
		// `putRecord` rather than `createRecord`: `self` is a singleton, and an
		// edit must overwrite rather than fail on a record that already exists.
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
 * Reconciles a group's rule records against the desired list.
 *
 * `existing` is passed in rather than read here, so the caller decides how it
 * got the current state: the route reads it through `./about-read.ts`, and a
 * test can supply it directly.
 *
 * Duplicate text in `desired` collapses: two identical rules are one rule.
 */
export async function setGroupRules(
	input: WriteGroupAboutInput & { desired: string[]; existing: GroupRuleRecord[] }
): Promise<RulesWriteResult> {
	await requireGroupPermission(input, 'MANAGE_GROUP');
	const space = aboutSpace(input.group);
	const writer = input.writer ?? (await groupWriter(input.env, input.db, input.group));

	const desired: string[] = [];
	const seen = new Set<string>();
	for (const text of input.desired) {
		const trimmed = text.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		desired.push(trimmed);
	}

	// Text -> the record already holding it. First wins, so a space that somehow
	// contains the same rule twice loses the duplicate on the next save.
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
			// The order may have moved even when the text did not, so the record is
			// rewritten in place with the same rkey and URI, and a rule that only
			// moved keeps every citation. That is why the order lives on the record
			// rather than being implied by the rkey.
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

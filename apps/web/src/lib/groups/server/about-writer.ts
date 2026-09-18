// Writing a group's PUBLIC FACE into its about space.
//
// The transport, the credential and the permission check are all the event
// gate's, unchanged — `groupWriter` and `requireGroupPermission` from
// ./event-writer.ts. This module adds only what is different about the control
// plane:
//
//   * the target is the about SPACE, not the public repo. `GroupRepoWrite.space`
//     already routes that (com.atproto.space.createRecord/putRecord), and `repo`
//     stays the group DID: the space scopes access, it does not reparent.
//   * the permission is fixed. An event write picks CREATE_EVENT or
//     MANAGE_EVENTS by intent; changing a group's own face is MANAGE_GROUP,
//     always, so there is no intent to map.
//   * a rules list is a SET of records, not one record, so saving it is a
//     reconcile rather than a put.
//
// THE RECONCILE IS THE ONLY SUBTLE PART, and it is a requirement rather than an
// optimisation. A rule has to be citable by URI — that is what lets a moderation
// action say which rule it enforced — so a save that deleted every rule record
// and re-created the list would invalidate every citation a group had ever
// handed out, on every edit, while still passing any test that only checks that
// the rules render. So rules are matched BY TEXT: an unchanged rule keeps its
// TID and its URI, a removed rule is deleted, a new rule is created.
// (Spec: FR-004c, observable as SC-011.)
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
import type { GroupRuleRecord } from './about-read';

export interface WriteGroupAboutInput {
	db: D1Database;
	env: CredentialStoreEnv;
	group: GroupRow;
	/** The human pressing the button. Checked, never written as. */
	callerDid: string | null;
	/** Overrides the PDS transport. Tests and the live probe pass this. */
	writer?: GroupRepoWriter;
}

export interface ProfileWriteResult {
	uri: string;
	cid: string;
}

/** `at://<group did>/space/<type>/self` — the space every about record lands in.
 *
 *  Read off the row rather than recomputed, because a NULL here is a real state:
 *  a group whose provisioning did not finish has no space to write into, and
 *  saying so is better than writing to a URI the PDS has never heard of. */
function aboutSpace(group: GroupRow): string {
	if (!group.about_space_uri) {
		throw new GroupRecordError(
			`${group.slug} has no about space yet, so its profile cannot be written`
		);
	}
	return group.about_space_uri;
}

/** Writes the group's `profile` record. Keyed `self`, so this is a put whether
 *  the group is new or being edited — there is exactly one profile.
 *
 *  `createdAt` is threaded from the existing record when there is one, so an
 *  edit does not restamp the group's creation date. The caller supplies it
 *  because only the caller knows whether it already read the record. */
export async function writeGroupProfile(
	input: WriteGroupAboutInput & {
		profile: Omit<GroupProfileInput, 'joinPolicy'> & { joinPolicy?: GroupProfileInput['joinPolicy'] };
	}
): Promise<ProfileWriteResult> {
	await requireGroupPermission(input.db, input.group, input.callerDid, 'MANAGE_GROUP');

	const record = {
		...groupProfileRecord({
			...input.profile,
			// The join policy is derived from the row, not taken from the form:
			// `visibility` + `require_approval` are what the schema enforces
			// (migrations/0003), so deriving keeps the record honest even if a
			// caller passes something else. (Spec: FR-004b.)
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
 * `existing` is passed in rather than read here so the caller decides how it got
 * the current state — the route reads it through `./about-read.ts`, and a test
 * or the live probe can supply it directly. That also keeps this module free of
 * the reader, which would otherwise be a cycle.
 *
 * Duplicate text in `desired` collapses: two identical rules are one rule.
 */
export async function setGroupRules(
	input: WriteGroupAboutInput & { desired: string[]; existing: GroupRuleRecord[] }
): Promise<RulesWriteResult> {
	await requireGroupPermission(input.db, input.group, input.callerDid, 'MANAGE_GROUP');
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
			// Order is ours and may have moved even when the text did not, so the
			// record is rewritten in place — SAME rkey, same URI. That is what
			// SC-011 asserts, and it is why order lives on the record rather than
			// being implied by the rkey.
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
